"""
Rebuilds the four sheets that were described in the case PDF but missing from the
shared workbook (README, Retailer_Master, Product_Master, Purchase_History).

Rules followed:
  * The three supplied sheets (Retailer_Preferences, Distributor_Inventory, Call_Scenarios)
    are used exactly as given -- never modified.
  * Every reconstructed value is derived from those sheets wherever possible
    (language -> state -> distributor, Typical_Order_Value -> basket value,
    Purchase_Frequency -> order cadence, Preferred_Brands -> SKUs bought,
    Cross_Sell_Opportunity -> what the history must/must not contain).
  * Fixed random seed, so the output is reproducible.
  * Pack conversions (pieces per box/case) are deliberately NOT supplied,
    matching scenario CS07 ("pack conversion is not supplied").
"""
import json, random, sys, datetime as dt
import pandas as pd

RAW = "data/raw"
OUT = "data"
random.seed(20261125)

AS_OF = dt.date(2026, 11, 20)          # same date as the Distributor_Inventory snapshot

# ---------------------------------------------------------------- supplied sheets
prefs = pd.read_csv(f"{RAW}/Retailer_Preferences.tsv", sep="\t")
scen = pd.read_csv(f"{RAW}/Call_Scenarios.tsv", sep="\t")
inv_rows = []
status_map = {"A": "Available", "L": "Low stock", "O": "Out of stock"}
for ln in open(f"{RAW}/Distributor_Inventory_compact.txt"):
    d, rest = ln.strip().split(": ")
    for tok in rest.split():
        sku, v = tok.split("=")
        u, s = v.split("/")
        inv_rows.append({"Distributor_ID": d, "SKU_ID": sku, "Available_Stock_Units": int(u),
                         "Stock_Status": status_map[s], "Last_Updated": "2026-11-20"})
inv = pd.DataFrame(inv_rows)

# ---------------------------------------------------------------- Product_Master (illustrative)
# MRPs and billing prices are illustrative round numbers, not Marico price lists.
products = [
    # id,  brand,      name,                                        size,  ml_or_g, unit_kind, category,          mrp,  bill, unit
    ("P001", "Parachute", "Parachute Coconut Oil",                    "100 ml", 100, "ml", "Hair & Edible Coconut Oil", 52,  44,  "Bottle"),
    ("P002", "Parachute", "Parachute Coconut Oil",                    "200 ml", 200, "ml", "Hair & Edible Coconut Oil", 99,  84,  "Bottle"),
    ("P003", "Parachute", "Parachute Coconut Oil",                    "500 ml", 500, "ml", "Hair & Edible Coconut Oil", 230, 196, "Bottle"),
    ("P004", "Parachute", "Parachute Coconut Oil",                    "1 L",   1000, "ml", "Hair & Edible Coconut Oil", 430, 366, "Jar"),
    ("P005", "Parachute", "Parachute Advansed Jasmine Hair Oil",      "200 ml", 200, "ml", "Value-added Hair Oil",      120, 100, "Bottle"),
    ("P006", "Saffola",   "Saffola Gold Edible Oil",                  "1 L",   1000, "ml", "Edible Oil",               210, 182, "Pouch"),
    ("P007", "Saffola",   "Saffola Gold Edible Oil",                  "5 L",   5000, "ml", "Edible Oil",              1000, 870, "Jar"),
    ("P008", "Saffola",   "Saffola Active Edible Oil",                "1 L",   1000, "ml", "Edible Oil",               195, 168, "Pouch"),
    ("P009", "Saffola",   "Saffola Masala Oats",                      "40 g",    40, "g",  "Foods",                     15,  13, "Pack"),
    ("P010", "Saffola",   "Saffola Masala Oats",                      "500 g",  500, "g",  "Foods",                    190, 160, "Pack"),
    ("P011", "Saffola",   "Saffola Oats",                             "1 kg",  1000, "g",  "Foods",                    199, 168, "Pack"),
    ("P012", "Nihar",     "Nihar Naturals Shanti Badam Amla Hair Oil", "100 ml", 100, "ml", "Value-added Hair Oil",      40,  34, "Bottle"),
    ("P013", "Nihar",     "Nihar Naturals Shanti Badam Amla Hair Oil", "300 ml", 300, "ml", "Value-added Hair Oil",     115,  97, "Bottle"),
    ("P014", "Nihar",     "Nihar Naturals Coconut Oil",               "200 ml", 200, "ml", "Hair & Edible Coconut Oil",  80,  68, "Bottle"),
    ("P015", "Livon",     "Livon Hair Serum",                         "50 ml",   50, "ml", "Hair Styling",             199, 165, "Bottle"),
    ("P016", "Livon",     "Livon Hair Serum",                         "100 ml", 100, "ml", "Hair Styling",             340, 282, "Bottle"),
    ("P017", "Livon",     "Livon Super Styler Gel",                   "100 g",  100, "g",  "Hair Styling",             120, 100, "Tube"),
    ("P018", "Set Wet",   "Set Wet Deodorant Spray",                  "150 ml", 150, "ml", "Male Grooming",            199, 160, "Can"),
    ("P019", "Set Wet",   "Set Wet Hair Gel",                         "50 ml",   50, "ml", "Male Grooming",             50,  42, "Bottle"),
    ("P020", "Set Wet",   "Set Wet Hair Gel",                         "100 ml", 100, "ml", "Male Grooming",             99,  83, "Bottle"),
]
pm = pd.DataFrame(products, columns=["SKU_ID", "Brand", "Product_Name", "Pack_Size", "Pack_Measure",
                                     "Pack_Measure_Unit", "Category", "MRP_INR",
                                     "Distributor_Billing_Price_INR", "Selling_Unit"])
pm["Case_Pack_Pieces"] = ""   # intentionally blank: conversion not supplied (CS07)
price = dict(zip(pm.SKU_ID, pm.Distributor_Billing_Price_INR))
brand_skus = pm.groupby("Brand").SKU_ID.apply(list).to_dict()

# ---------------------------------------------------------------- Retailer_Master
geo = {  # language -> list of (city, state, distributor)
    "Hindi":     [("Lucknow", "Uttar Pradesh", "D001"), ("Kanpur", "Uttar Pradesh", "D001"),
                  ("New Delhi", "Delhi", "D001"), ("Indore", "Madhya Pradesh", "D002"),
                  ("Jaipur", "Rajasthan", "D002"), ("Patna", "Bihar", "D002")],
    "Gujarati":  [("Ahmedabad", "Gujarat", "D003"), ("Surat", "Gujarat", "D003"), ("Rajkot", "Gujarat", "D003")],
    "Marathi":   [("Pune", "Maharashtra", "D004"), ("Nagpur", "Maharashtra", "D004"), ("Nashik", "Maharashtra", "D004")],
    "Tamil":     [("Chennai", "Tamil Nadu", "D005"), ("Coimbatore", "Tamil Nadu", "D005"), ("Madurai", "Tamil Nadu", "D005")],
    "Telugu":    [("Hyderabad", "Telangana", "D006"), ("Vijayawada", "Andhra Pradesh", "D006"), ("Warangal", "Telangana", "D006")],
    "Kannada":   [("Bengaluru", "Karnataka", "D007"), ("Mysuru", "Karnataka", "D007")],
    "Malayalam": [("Kochi", "Kerala", "D008"), ("Kozhikode", "Kerala", "D008")],
    "Bengali":   [("Kolkata", "West Bengal", "D009"), ("Howrah", "West Bengal", "D009")],
    "Odia":      [("Bhubaneswar", "Odisha", "D009"), ("Cuttack", "Odisha", "D009")],
    "Assamese":  [("Guwahati", "Assam", "D010"), ("Dibrugarh", "Assam", "D010")],
}
surnames = {
    "Hindi": ["Sharma", "Gupta", "Verma", "Yadav", "Agarwal", "Singh", "Mishra", "Jain", "Pandey", "Khan",
              "Tiwari", "Chauhan", "Saxena", "Rastogi", "Bansal"],
    "Gujarati": ["Patel", "Shah", "Desai", "Mehta", "Joshi"],
    "Marathi": ["Patil", "Deshmukh", "Kulkarni", "Jadhav", "Pawar"],
    "Tamil": ["Murugan", "Selvam", "Kannan", "Arumugam", "Rajendran"],
    "Telugu": ["Reddy", "Naidu", "Prasad", "Rao", "Varma"],
    "Kannada": ["Gowda", "Shetty", "Hegde"],
    "Malayalam": ["Nair", "Menon", "Pillai"],
    "Bengali": ["Das", "Ghosh", "Saha"],
    "Odia": ["Mohanty", "Sahu", "Behera"],
    "Assamese": ["Bora", "Gogoi", "Baruah"],
}
first_names = ["Ramesh", "Suresh", "Mahesh", "Rajesh", "Dinesh", "Anil", "Sunil", "Vijay", "Ashok", "Prakash",
               "Sanjay", "Manoj", "Ravi", "Arun", "Kiran", "Deepak", "Mohan", "Gopal", "Lakshmi", "Meena"]
shop_suffix = ["General Store", "Kirana Store", "Provision Store", "Traders", "Super Bazaar", "Stores"]
outlet_types = ["Kirana", "Kirana", "Kirana", "General Store", "General Store", "Cosmetics & Personal Care",
                "Chemist", "Wholesale-cum-Retail"]


def segment(tov):
    if tov >= 10000: return "A - High value"
    if tov >= 6000: return "B - Medium-high"
    if tov >= 3000: return "C - Medium"
    return "D - Small"


lang_counter = {k: 0 for k in geo}
rm = []
for _, r in prefs.iterrows():
    lang = r.Preferred_Language
    i = lang_counter[lang]; lang_counter[lang] += 1
    city, state, dist = geo[lang][i % len(geo[lang])]
    sn = surnames[lang][i % len(surnames[lang])]
    fn = first_names[(int(r.Retailer_ID[1:]) * 7) % len(first_names)]
    shop = f"{sn} {shop_suffix[(i + int(r.Retailer_ID[1:])) % len(shop_suffix)]}"
    otype = "Wholesale-cum-Retail" if r.Typical_Order_Value_INR >= 15000 else outlet_types[int(r.Retailer_ID[1:]) % len(outlet_types)]
    rm.append({"Retailer_ID": r.Retailer_ID, "Retailer_Name": shop, "Owner_Name": f"{fn} {sn}",
               "City": city, "State": state, "Preferred_Language": lang, "Outlet_Type": otype,
               "Segment": segment(r.Typical_Order_Value_INR), "Distributor_ID": dist,
               "Contact_Number_Synthetic": f"+91-90000-{10000 + int(r.Retailer_ID[1:]):05d}"})
rm = pd.DataFrame(rm)

# Demo persona used in the case PDF ("Sharma ji", Parachute 500 ml x12, 200 ml x8, Saffola Gold):
# R042 is a Hindi retailer who buys Saffola, Nihar, Set Wet and Parachute -> make him "Sharma ji".
rm.loc[rm.Retailer_ID == "R042", ["Retailer_Name", "Owner_Name", "City", "State", "Distributor_ID"]] = \
    ["Sharma General Store", "Ramesh Sharma", "Lucknow", "Uttar Pradesh", "D001"]

# ---------------------------------------------------------------- Purchase_History
ph = []
for _, r in prefs.iterrows():
    rid = r.Retailer_ID
    brands = [b.strip() for b in r.Preferred_Brands.split(",")]
    freq, tov, hint = int(r.Purchase_Frequency_Days), float(r.Typical_Order_Value_INR), r.Cross_Sell_Opportunity
    chosen = {}  # sku -> weight
    for b in brands:
        skus = brand_skus[b]
        if b == "Parachute":
            core = ["P002", "P003"]
            if hint.startswith("Parachute 200"):
                core = ["P002"]                 # trade-up target (P003) must not already be bought
            extra = [s for s in ["P001", "P004", "P005"] if random.random() < 0.8]
            for s in core: chosen[s] = 3.0
            for s in extra: chosen[s] = 1.2
        elif b == "Saffola":
            core = ["P006"]
            pool = ["P007", "P008"] + ([] if hint == "Saffola Oats cross-sell" else ["P009", "P010", "P011"])
            extra = [s for s in pool if random.random() < 0.65]
            for s in core: chosen[s] = 3.0
            for s in extra: chosen[s] = 1.0
        else:
            k = random.choice([2, 3, 3])
            for j, s in enumerate(random.sample(skus, k)):
                chosen[s] = 2.0 if j == 0 else 1.0
    if hint.startswith("Livon / Set Wet") and not ("Livon" in brands and "Set Wet" in brands):
        pass  # the missing brand stays absent -> genuine cross-sell
    # per-cycle value split
    wsum = sum(chosen.values())
    d_r = max(1, round(freq * random.uniform(0.4, 1.6)))   # days since retailer's last order
    for s, w in chosen.items():
        cyc_val = tov * w / wsum
        cyc_qty = max(1, round(cyc_val / price[s]))
        lapse = 0 if w >= 2 else random.choice([0, 0, 0, 1, 2])
        days = d_r + lapse * freq
        last_q = max(1, round(cyc_qty * random.uniform(0.8, 1.2)))
        prev_q = max(1, round(cyc_qty * random.uniform(0.8, 1.2)))
        ph.append({"Retailer_ID": rid, "SKU_ID": s,
                   "Last_Order_Date": (AS_OF - dt.timedelta(days=days)).isoformat(),
                   "Last_Order_Qty": last_q, "Previous_Order_Qty": prev_q,
                   "Avg_Monthly_Qty": round(cyc_qty * 30 / freq, 1),
                   "Days_Since_Last_Order": days})
ph = pd.DataFrame(ph).sort_values(["Retailer_ID", "SKU_ID"]).reset_index(drop=True)

# Demo persona: make R042's Parachute lines match the case PDF dialogue (500 ml x12, 200 ml x8)
# and make the retailer due for a call (last order 11 days ago vs a 9-day cycle).
for sku, q, pq in (("P003", 12, 10), ("P002", 8, 9)):
    m = (ph.Retailer_ID == "R042") & (ph.SKU_ID == sku)
    if m.any():
        ph.loc[m, "Last_Order_Qty"] = q
        ph.loc[m, "Previous_Order_Qty"] = pq
        ph.loc[m, "Avg_Monthly_Qty"] = round((q + pq) / 2 * 30 / 9, 1)
m42 = ph.Retailer_ID == "R042"
shift = 11 - ph.loc[m42, "Days_Since_Last_Order"].min()
ph.loc[m42, "Days_Since_Last_Order"] += shift
ph.loc[m42, "Last_Order_Date"] = ph.loc[m42, "Days_Since_Last_Order"].apply(lambda d: (AS_OF - dt.timedelta(days=int(d))).isoformat())

# ---------------------------------------------------------------- README
readme = pd.DataFrame([
    ["Purpose", "Synthetic, illustrative data for the Marico x IIT Madras AI telecalling challenge. Not Marico internal data."],
    ["Supplied sheets (used unchanged)", "Retailer_Preferences (100 rows), Distributor_Inventory (200 rows, snapshot 2026-11-20), Call_Scenarios (19 rows)."],
    ["Reconstructed sheets", "Retailer_Master, Product_Master, Purchase_History were described in the brief but absent from the shared workbook. "
                             "They were rebuilt by scripts/reconstruct_missing_sheets.py (seed 20261125) so that they agree with the supplied sheets."],
    ["Retailer_Master", "Language -> state/city -> distributor (D001-D010). Segment from Typical_Order_Value_INR (A >= 10k, B >= 6k, C >= 3k, D < 3k). Contact numbers are synthetic."],
    ["Product_Master", "20 SKUs across the five brands named in Retailer_Preferences. Prices are illustrative. Case_Pack_Pieces left blank on purpose (CS07: conversion not supplied)."],
    ["Purchase_History", "Only SKUs of each retailer's Preferred_Brands. Per-order basket value is calibrated to Typical_Order_Value_INR; cadence to Purchase_Frequency_Days. "
                         "Cross-sell targets are kept out of history (e.g. no 500 ml for trade-up retailers, no oats for oats cross-sell)."],
    ["Usage rules (from brief)", "Use Retailer_Master distributor mapping for stock checks. Never accept quantity above Available_Stock_Units. "
                                 "Use Distributor_Billing_Price_INR for order value; MRP is reference only."],
    ["Swap-in", "If the official sheets are provided, drop them into the workbook with the same names; the agent reads whichever is present."],
], columns=["Item", "Description"])

# ---------------------------------------------------------------- write
with pd.ExcelWriter(f"{OUT}/Marico_CaseStudy_Data_Completed.xlsx") as xw:
    readme.to_excel(xw, "README", index=False)
    rm.to_excel(xw, "Retailer_Master", index=False)
    pm.to_excel(xw, "Product_Master", index=False)
    ph.to_excel(xw, "Purchase_History", index=False)
    inv.to_excel(xw, "Distributor_Inventory", index=False)
    prefs.to_excel(xw, "Retailer_Preferences", index=False)
    scen.to_excel(xw, "Call_Scenarios", index=False)

bundle = {
    "meta": {"as_of": AS_OF.isoformat(), "inventory_snapshot": "2026-11-20",
             "supplied": ["Retailer_Preferences", "Distributor_Inventory", "Call_Scenarios"],
             "reconstructed": ["Retailer_Master", "Product_Master", "Purchase_History"]},
    "retailers": rm.to_dict("records"),
    "preferences": prefs.to_dict("records"),
    "products": pm.to_dict("records"),
    "history": ph.to_dict("records"),
    "inventory": inv.to_dict("records"),
    "scenarios": scen.to_dict("records"),
}
json.dump(bundle, open(f"{OUT}/marico_data.json", "w"), indent=0)
json.dump(bundle, open("marico_data.json", "w"), separators=(",", ":"), ensure_ascii=False)   # copy the web page loads
print("Purchase_History rows:", len(ph), "| retailers:", ph.Retailer_ID.nunique(),
      "| SKUs/retailer avg:", round(len(ph) / 100, 1))
