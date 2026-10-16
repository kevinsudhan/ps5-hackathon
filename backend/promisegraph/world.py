"""The static world: hubs, carriers and lanes.

Geography is real public data (UN/LOCODE port codes, IATA airport codes, approximate
coordinates). Companies and carriers are fictional. Transit days are rough but believable
round numbers, not quotes from any real carrier schedule.
"""

# (id, name, kind, country, lat, lon)
PORTS = [
    ("CNSHA", "Port of Shanghai", "port", "CN", 31.23, 121.47),
    ("CNNGB", "Port of Ningbo-Zhoushan", "port", "CN", 29.87, 121.55),
    ("CNYTN", "Port of Shenzhen Yantian", "port", "CN", 22.57, 114.27),
    ("KRPUS", "Port of Busan", "port", "KR", 35.10, 129.04),
    ("TWKHH", "Port of Kaohsiung", "port", "TW", 22.61, 120.28),
    ("VNSGN", "Port of Ho Chi Minh City (Cat Lai)", "port", "VN", 10.76, 106.79),
    ("SGSIN", "Port of Singapore", "port", "SG", 1.26, 103.84),
    ("MYTPP", "Port of Tanjung Pelepas", "port", "MY", 1.36, 103.55),
    ("MYPKG", "Port Klang", "port", "MY", 3.00, 101.39),
    ("LKCMB", "Port of Colombo", "port", "LK", 6.95, 79.85),
    ("BDCGP", "Port of Chittagong", "port", "BD", 22.31, 91.80),
    ("INMAA", "Port of Chennai", "port", "IN", 13.10, 80.29),
    ("INNSA", "Nhava Sheva (JNPT)", "port", "IN", 18.95, 72.95),
    ("AEJEA", "Jebel Ali", "port", "AE", 25.01, 55.06),
    ("EGPSD", "Port Said", "port", "EG", 31.26, 32.30),
    ("ESALG", "Port of Algeciras", "port", "ES", 36.13, -5.44),
    ("MAPTM", "Tanger Med", "port", "MA", 35.89, -5.50),
    ("NLRTM", "Port of Rotterdam", "port", "NL", 51.95, 4.14),
    ("BEANR", "Port of Antwerp-Bruges", "port", "BE", 51.26, 4.40),
    ("DEHAM", "Port of Hamburg", "port", "DE", 53.54, 9.97),
    ("GBFXT", "Port of Felixstowe", "port", "GB", 51.96, 1.35),
    ("USLAX", "Port of Los Angeles", "port", "US", 33.74, -118.27),
    ("USLGB", "Port of Long Beach", "port", "US", 33.75, -118.21),
    ("USNYC", "Port of New York and New Jersey", "port", "US", 40.68, -74.15),
    ("USSAV", "Port of Savannah", "port", "US", 32.08, -81.09),
]

AIRPORTS = [
    ("APT-HKG", "Hong Kong International Airport", "airport", "HK", 22.31, 113.92),
    ("APT-PVG", "Shanghai Pudong Airport", "airport", "CN", 31.14, 121.81),
    ("APT-SIN", "Singapore Changi Airport", "airport", "SG", 1.36, 103.99),
    ("APT-SGN", "Tan Son Nhat Airport", "airport", "VN", 10.82, 106.66),
    ("APT-DAC", "Dhaka Shahjalal Airport", "airport", "BD", 23.84, 90.40),
    ("APT-MAA", "Chennai Airport", "airport", "IN", 12.99, 80.17),
    ("APT-DXB", "Dubai International Airport", "airport", "AE", 25.25, 55.36),
    ("APT-FRA", "Frankfurt Airport", "airport", "DE", 50.04, 8.56),
    ("APT-AMS", "Amsterdam Schiphol", "airport", "NL", 52.31, 4.76),
    ("APT-LHR", "London Heathrow", "airport", "GB", 51.47, -0.45),
    ("APT-LAX", "Los Angeles International", "airport", "US", 33.94, -118.41),
    ("APT-ORD", "Chicago O'Hare", "airport", "US", 41.97, -87.91),
    ("APT-JFK", "New York JFK", "airport", "US", 40.64, -73.78),
]

# Supplier and factory sites (fictional companies, real towns). Each has a gateway port.
SITES = [
    # electronics chain
    ("SUP-KCH", "Borneo Silicon Works, Kuching", "supplier", "MY", 1.55, 110.36, "SGSIN"),
    ("SUP-HSC", "Hsinchu Wafer Foundry", "supplier", "TW", 24.80, 120.97, "TWKHH"),
    ("SUP-PEN", "Penang Chip Packaging", "supplier", "MY", 5.41, 100.33, "MYPKG"),
    ("SUP-BTM", "Batam Module Assembly", "supplier", "ID", 1.13, 104.05, "SGSIN"),
    ("SUP-JHB", "Johor PCB Fabrication", "supplier", "MY", 1.49, 103.74, "MYTPP"),
    ("FAC-DGN", "Dongguan Device Assembly", "factory", "CN", 23.02, 113.75, "CNYTN"),
    # apparel chain
    ("SUP-RJK", "Rajkot Cotton Ginning", "supplier", "IN", 22.30, 70.80, "INNSA"),
    ("SUP-CBE", "Coimbatore Spinning Mills", "supplier", "IN", 11.02, 76.96, "INMAA"),
    ("SUP-NTG", "Nantong Weaving Co", "supplier", "CN", 31.98, 120.89, "CNSHA"),
    ("SUP-SNG", "Jurong Specialty Dyes", "supplier", "SG", 1.33, 103.70, "SGSIN"),
    ("SUP-CTG", "Chittagong Trims & Finishing", "supplier", "BD", 22.35, 91.83, "BDCGP"),
    ("FAC-DAC", "Dhaka Garment Works", "factory", "BD", 23.81, 90.41, "BDCGP"),
    # home and kitchen chain
    ("SUP-ULS", "Ulsan Steel Coil", "supplier", "KR", 35.54, 129.31, "KRPUS"),
    ("SUP-PKG", "Klang Valley Polymers", "supplier", "MY", 3.04, 101.45, "MYPKG"),
    ("SUP-BNH", "Bien Hoa Foam & Resin", "supplier", "VN", 10.95, 106.82, "VNSGN"),
    ("SUP-CHN", "Chennai Motor Components", "supplier", "IN", 12.97, 80.05, "INMAA"),
    ("SUP-NGB", "Ningbo Fittings Co", "supplier", "CN", 29.87, 121.54, "CNNGB"),
    ("FAC-SZH", "Suzhou Appliance Plant", "factory", "CN", 31.30, 120.62, "CNSHA"),
    # furniture chain
    ("SUP-SBH", "Sabah Timber Mill", "supplier", "MY", 5.98, 116.07, "MYPKG"),
    ("SUP-PNQ", "Pune Hardware Forge", "supplier", "IN", 18.52, 73.86, "INNSA"),
    ("SUP-KHH", "Kaohsiung Fabric Coating", "supplier", "TW", 22.63, 120.30, "TWKHH"),
    ("SUP-JBF", "Johor Board & Fibre", "supplier", "MY", 1.55, 103.80, "MYTPP"),
    ("SUP-HCM", "Long An Upholstery Supply", "supplier", "VN", 10.54, 106.41, "VNSGN"),
    ("FAC-BDU", "Binh Duong Furniture Works", "factory", "VN", 11.17, 106.65, "VNSGN"),
]

# Product families: supply chain from most-upstream supplier to the final factory.
FAMILIES = {
    "electronics": {
        "chain": ["SUP-KCH", "SUP-HSC", "SUP-PEN", "SUP-BTM", "SUP-JHB"],
        "factory": "FAC-DGN",
        "parts": ["silicon wafers", "bare dies", "packaged chips", "radio modules", "PCB assemblies"],
        "goods": "smart home devices",
        "air_share": 0.25,
    },
    "apparel": {
        "chain": ["SUP-RJK", "SUP-CBE", "SUP-NTG", "SUP-SNG", "SUP-CTG"],
        "factory": "FAC-DAC",
        "parts": ["ginned cotton", "cotton yarn", "woven fabric", "reactive dyes", "trims and labels"],
        "goods": "winter apparel",
        "air_share": 0.08,
    },
    "home": {
        "chain": ["SUP-ULS", "SUP-PKG", "SUP-BNH", "SUP-CHN", "SUP-NGB"],
        "factory": "FAC-SZH",
        "parts": ["steel coil", "polymer pellets", "insulation foam", "motor components", "brass fittings"],
        "goods": "kitchen appliances",
        "air_share": 0.05,
    },
    "furniture": {
        "chain": ["SUP-SBH", "SUP-PNQ", "SUP-KHH", "SUP-JBF", "SUP-HCM"],
        "factory": "FAC-BDU",
        "parts": ["sawn timber", "hinges and brackets", "coated fabric", "fibre board", "upholstery kits"],
        "goods": "flat-pack furniture",
        "air_share": 0.0,
    },
}

# Northwind Retail's own network: national DCs -> regional DCs -> delivery zones.
REGIONS = {
    "EU": {
        "national": ("DC-VNL", "Northwind DC Venlo", "NL", 51.37, 6.17),
        "ports": ["NLRTM", "BEANR", "DEHAM"],
        "airports": ["APT-AMS", "APT-FRA"],
        "weight": 0.40,
        "regional": {
            ("DC-DUI", "Northwind DC Duisburg", "DE", 51.43, 6.76): [
                ("ZN-BER", "Berlin", 52.52, 13.40), ("ZN-CGN", "Cologne", 50.94, 6.96),
                ("ZN-FRA", "Frankfurt", 50.11, 8.68), ("ZN-AMS", "Amsterdam", 52.37, 4.90),
                ("ZN-BRU", "Brussels", 50.85, 4.35)],
            ("DC-LYS", "Northwind DC Lyon", "FR", 45.76, 4.84): [
                ("ZN-PAR", "Paris", 48.86, 2.35), ("ZN-LYS", "Lyon", 45.76, 4.84),
                ("ZN-MRS", "Marseille", 43.30, 5.37)],
            ("DC-MXP", "Northwind DC Milan", "IT", 45.46, 9.19): [
                ("ZN-MIL", "Milan", 45.46, 9.19), ("ZN-ROM", "Rome", 41.90, 12.50),
                ("ZN-ZRH", "Zurich", 47.38, 8.54)],
            ("DC-MAD", "Northwind DC Madrid", "ES", 40.42, -3.70): [
                ("ZN-MAD", "Madrid", 40.42, -3.70), ("ZN-BCN", "Barcelona", 41.39, 2.17),
                ("ZN-LIS", "Lisbon", 38.72, -9.14)],
        },
    },
    "UK": {
        "national": ("DC-DAV", "Northwind DC Daventry", "GB", 52.26, -1.16),
        "ports": ["GBFXT"],
        "airports": ["APT-LHR"],
        "weight": 0.15,
        "regional": {
            ("DC-MAN", "Northwind DC Manchester", "GB", 53.48, -2.24): [
                ("ZN-MAN", "Manchester", 53.48, -2.24), ("ZN-LDS", "Leeds", 53.80, -1.55),
                ("ZN-LIV", "Liverpool", 53.41, -2.98)],
            ("DC-BRS", "Northwind DC Bristol", "GB", 51.45, -2.59): [
                ("ZN-LON", "London", 51.51, -0.13), ("ZN-BRS", "Bristol", 51.45, -2.59),
                ("ZN-CWL", "Cardiff", 51.48, -3.18)],
            ("DC-GLA", "Northwind DC Glasgow", "GB", 55.86, -4.25): [
                ("ZN-GLA", "Glasgow", 55.86, -4.25), ("ZN-EDI", "Edinburgh", 55.95, -3.19)],
        },
    },
    "USW": {
        "national": ("DC-ONT", "Northwind DC Inland Empire", "US", 34.06, -117.65),
        "ports": ["USLAX", "USLGB"],
        "airports": ["APT-LAX"],
        "weight": 0.25,
        "regional": {
            ("DC-PHX", "Northwind DC Phoenix", "US", 33.45, -112.07): [
                ("ZN-PHX", "Phoenix", 33.45, -112.07), ("ZN-LAS", "Las Vegas", 36.17, -115.14),
                ("ZN-ABQ", "Albuquerque", 35.08, -106.65)],
            ("DC-SEA", "Northwind DC Seattle", "US", 47.61, -122.33): [
                ("ZN-SEA", "Seattle", 47.61, -122.33), ("ZN-PDX", "Portland", 45.52, -122.68)],
            ("DC-DEN", "Northwind DC Denver", "US", 39.74, -104.99): [
                ("ZN-DEN", "Denver", 39.74, -104.99), ("ZN-SLC", "Salt Lake City", 40.76, -111.89)],
        },
    },
    "USE": {
        "national": ("DC-SVE", "Northwind DC Savannah", "US", 32.13, -81.20),
        "ports": ["USSAV", "USNYC"],
        "airports": ["APT-JFK", "APT-ORD"],
        "weight": 0.20,
        "regional": {
            ("DC-ATL", "Northwind DC Atlanta", "US", 33.75, -84.39): [
                ("ZN-ATL", "Atlanta", 33.75, -84.39), ("ZN-CLT", "Charlotte", 35.23, -80.84),
                ("ZN-MIA", "Miami", 25.76, -80.19)],
            ("DC-EWR", "Northwind DC Edison", "US", 40.52, -74.41): [
                ("ZN-NYC", "New York", 40.71, -74.01), ("ZN-BOS", "Boston", 42.36, -71.06),
                ("ZN-PHL", "Philadelphia", 39.95, -75.17)],
            ("DC-JOL", "Northwind DC Joliet", "US", 41.53, -88.08): [
                ("ZN-CHI", "Chicago", 41.88, -87.63), ("ZN-DTW", "Detroit", 42.33, -83.05),
                ("ZN-MSP", "Minneapolis", 44.98, -93.27)],
            ("DC-DFW", "Northwind DC Dallas", "US", 32.78, -96.80): [
                ("ZN-DAL", "Dallas", 32.78, -96.80), ("ZN-HOU", "Houston", 29.76, -95.37),
                ("ZN-AUS", "Austin", 30.27, -97.74)],
        },
    },
}

# Fictional carriers.
CARRIERS = [
    ("CAR-MOL", "Meridian Ocean Lines", "ocean"),
    ("CAR-BAS", "Blue Anchor Shipping", "ocean"),
    ("CAR-KCL", "Kestrel Container Line", "ocean"),
    ("CAR-OAC", "Orion Air Cargo", "air"),
    ("CAR-SAF", "Swiftwing Air Freight", "air"),
    ("CAR-AOL", "Asia Overland Logistics", "truck"),
    ("CAR-NLH", "Northline Haulage", "truck"),
    ("CAR-RRC", "Rhine Rail Cargo", "rail"),
    ("CAR-PDC", "Pacific Drayage Co", "truck"),
    ("CAR-PFW", "Prairie Freightways", "truck"),
    ("CAR-DSX", "Doorstep Express", "parcel"),
    ("CAR-PLP", "Porchlight Parcel", "parcel"),
]

# Ocean lanes, both directions: (a, b, transit_days)
OCEAN_LANES = [
    ("CNSHA", "CNNGB", 1), ("CNNGB", "CNYTN", 2), ("CNSHA", "KRPUS", 2), ("CNSHA", "CNYTN", 3),
    ("TWKHH", "CNYTN", 2), ("TWKHH", "CNSHA", 2), ("TWKHH", "SGSIN", 5), ("CNYTN", "SGSIN", 4),
    ("CNYTN", "MYTPP", 4), ("CNYTN", "VNSGN", 3), ("VNSGN", "SGSIN", 2), ("VNSGN", "MYTPP", 2),
    ("SGSIN", "MYTPP", 1), ("SGSIN", "MYPKG", 1), ("MYTPP", "MYPKG", 1), ("MYPKG", "LKCMB", 4),
    ("SGSIN", "LKCMB", 4), ("MYTPP", "LKCMB", 4), ("BDCGP", "SGSIN", 5), ("BDCGP", "LKCMB", 4),
    ("BDCGP", "MYPKG", 4), ("INMAA", "LKCMB", 2), ("INMAA", "SGSIN", 4), ("INNSA", "LKCMB", 3),
    ("INNSA", "AEJEA", 3), ("LKCMB", "AEJEA", 5), ("LKCMB", "EGPSD", 10), ("AEJEA", "EGPSD", 6),
    ("SGSIN", "EGPSD", 13), ("MYTPP", "EGPSD", 13), ("EGPSD", "ESALG", 5), ("EGPSD", "MAPTM", 5),
    ("ESALG", "NLRTM", 4), ("MAPTM", "NLRTM", 4), ("ESALG", "GBFXT", 4), ("MAPTM", "GBFXT", 4),
    ("NLRTM", "BEANR", 1), ("NLRTM", "DEHAM", 1), ("NLRTM", "GBFXT", 1), ("BEANR", "GBFXT", 1),
    ("ESALG", "USNYC", 9), ("MAPTM", "USSAV", 10), ("EGPSD", "USNYC", 12), ("USNYC", "USSAV", 2),
    ("CNSHA", "USLAX", 14), ("CNYTN", "USLGB", 15), ("KRPUS", "USLAX", 11), ("KRPUS", "USLGB", 11),
    ("SGSIN", "USLAX", 18), ("VNSGN", "USLGB", 17), ("TWKHH", "USLAX", 13), ("SGSIN", "INMAA", 4),
    ("MYPKG", "INNSA", 6),
]

AIR_LANES = [
    ("APT-HKG", "APT-FRA"), ("APT-HKG", "APT-AMS"), ("APT-HKG", "APT-LHR"), ("APT-HKG", "APT-LAX"),
    ("APT-HKG", "APT-ORD"), ("APT-HKG", "APT-JFK"), ("APT-PVG", "APT-FRA"), ("APT-PVG", "APT-LAX"),
    ("APT-PVG", "APT-ORD"), ("APT-SIN", "APT-FRA"), ("APT-SIN", "APT-AMS"), ("APT-SIN", "APT-LHR"),
    ("APT-SIN", "APT-LAX"), ("APT-DXB", "APT-FRA"), ("APT-DXB", "APT-AMS"), ("APT-DXB", "APT-LHR"),
    ("APT-DXB", "APT-JFK"), ("APT-MAA", "APT-DXB"), ("APT-MAA", "APT-SIN"), ("APT-SGN", "APT-SIN"),
    ("APT-SGN", "APT-HKG"), ("APT-HKG", "APT-SIN"), ("APT-PVG", "APT-HKG"), ("APT-DAC", "APT-DXB"),
    ("APT-DAC", "APT-SIN"),
]

# Short truck links between a port and its nearby airport (used by reroutes to air freight).
PORT_AIRPORT_LINKS = [
    ("CNYTN", "APT-HKG"), ("CNSHA", "APT-PVG"), ("SGSIN", "APT-SIN"), ("MYTPP", "APT-SIN"),
    ("VNSGN", "APT-SGN"), ("INMAA", "APT-MAA"), ("AEJEA", "APT-DXB"), ("BDCGP", "APT-DAC"),
]

# Factory -> airport it trucks air freight to.
FACTORY_AIRPORTS = {"FAC-DGN": "APT-HKG", "FAC-DAC": "APT-DAC", "FAC-SZH": "APT-PVG", "FAC-BDU": "APT-SGN"}

# Domestic truck/rail links between ports, (a, b, days), both directions.
LAND_LANES = [("INNSA", "INMAA", 4), ("USLAX", "USLGB", 1)]
