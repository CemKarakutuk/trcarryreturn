#!/usr/bin/env python3
"""
data/raw/ klasöründeki ham dosyalardan data/dataset.json ve data/dataset.csv üretir.

Kullanım (repo kök dizininde):
    pip install pandas openpyxl
    python scripts/update_data.py

Dosyalar içeriklerine göre otomatik tanınır; adlarının bir önemi yoktur:
  - EVDS haftalık mevduat faizleri : TP_TRY_MT01 ... TP_TRY_MT06 sütunları
  - EVDS haftalık döviz kurları     : TP_DK_USD/EUR/GBP_A_YTL ve _S_YTL sütunları
  - EVDS aylık fiyat endeksleri     : TP_GENENDEKS_T1 (TÜFE), TP_TUFE1YI_T1 (Yİ-ÜFE)
  - Gram altın (TL/gram, haftalık)  : dosya adında "altin", "gold" veya "xau" geçen,
                                      başlıksız iki sütunlu dosya (tarih, fiyat)
  - Stopaj tablosu                  : dosya adında "stopaj" veya "tax" geçen dosya
  - TCMB politika faizi (aylık)     : TP_BISPOLFAIZ_TUR sütunu (BIS kaynaklı, EVDS)
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT_JSON = ROOT / "data" / "dataset.json"
OUT_CSV = ROOT / "data" / "dataset.csv"

RATE_CODES = [f"TP_TRY_MT0{i}" for i in range(1, 7)]
FX_CODES = {c: (f"TP_DK_{c}_A_YTL", f"TP_DK_{c}_S_YTL") for c in ("USD", "EUR", "GBP")}
CPI_CODES = {"tufe": "TP_GENENDEKS_T1", "ufe": "TP_TUFE1YI_T1"}
POLICY_CODE = "TP_BISPOLFAIZ_TUR"


def read_evds(path):
    """EVDS Excel çıktısını okur; alttaki açıklama satırlarını atar."""
    df = pd.read_excel(path, dtype=str)
    if "Tarih" not in df.columns:
        return None
    df = df[df["Tarih"].astype(str).str.match(r"^\d")].copy()
    for c in df.columns[1:]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def parse_pct(v):
    """'15,40%' → 15.4 ; Excel yüzde hücresi 0.154 → 15.4"""
    if isinstance(v, (int, float)):
        v = float(v)
        return round(v * 100, 4) if v < 1 else v
    return float(str(v).replace("%", "").replace(",", ".").strip())


def parse_stopaj(path):
    df = pd.read_excel(path, dtype=object)
    rows = []
    for _, r in df.iterrows():
        period = str(r.iloc[0]).strip()
        first = re.split(r"\s[–-]\s", period)[0]
        m = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", first)
        if m:
            start = f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
        else:
            y = re.search(r"(\d{4})", first)
            if not y:
                continue
            start = f"{y.group(1)}-01-01"
        rows.append({"start": start, "label": period,
                     "m6": parse_pct(r.iloc[1]), "y1": parse_pct(r.iloc[2]), "y1p": parse_pct(r.iloc[3])})
    rows.sort(key=lambda x: x["start"])
    return rows


def main():
    rates = fx = cpi = gold = stopaj = policy = None
    used = {}
    for f in sorted(RAW.glob("*.xls*")):
        name = f.name.lower()
        if any(k in name for k in ("stopaj", "tax")):
            stopaj = parse_stopaj(f)
            used["stopaj"] = f.name
            continue
        if any(k in name for k in ("altin", "altın", "gold", "xau")):
            g = pd.read_excel(f, header=None)
            g = g[pd.to_datetime(g[0], errors="coerce").notna()].copy()
            g["d"] = pd.to_datetime(g[0])
            # Haftalık altın verisi hafta başı (pazartesi) tarihli: aynı haftanın cumasına eşlenir.
            g["d"] = g["d"] + pd.to_timedelta((4 - g["d"].dt.weekday) % 7, unit="D")
            g["v"] = pd.to_numeric(g[1], errors="coerce")
            gold = g[["d", "v"]].dropna()
            used["gold"] = f.name
            continue
        df = read_evds(f)
        if df is None:
            print(f"  ! tanınmadı, atlandı: {f.name}")
            continue
        cols = set(df.columns)
        if set(RATE_CODES) <= cols:
            rates, used["rates"] = df, f.name
        elif all(a in cols and s in cols for a, s in FX_CODES.values()):
            fx, used["fx"] = df, f.name
        elif POLICY_CODE in cols:
            policy, used["policy"] = df, f.name
        elif set(CPI_CODES.values()) & cols:
            cpi, used["cpi"] = df, f.name
        else:
            print(f"  ! tanınmadı, atlandı: {f.name}")

    missing = [k for k, v in dict(faiz=rates, kur=fx, enflasyon=cpi, altin=gold, stopaj=stopaj).items() if v is None]
    if missing:
        sys.exit(f"Eksik veri: {', '.join(missing)} (data/raw klasörünü kontrol edin)")

    # Ana zaman ekseni: döviz kurlarının haftalık tarihleri
    fx["d"] = pd.to_datetime(fx["Tarih"], dayfirst=True)
    rates["d"] = pd.to_datetime(rates["Tarih"], dayfirst=True)
    base = fx[["d"] + [c for pair in FX_CODES.values() for c in pair]].sort_values("d")
    base = base.merge(rates[["d"] + RATE_CODES], on="d", how="left")
    base = base.merge(gold.rename(columns={"v": "XAU"}), on="d", how="left").reset_index(drop=True)
    # Henüz bitmemiş hafta(lar) çıkarılır: EVDS haftayı cuma tarihiyle etiketler ve
    # içinde bulunulan haftayı o ana kadarki günlerin ortalamasıyla doldurur.
    today = pd.Timestamp(datetime.now().date())
    dropped = base[base["d"] > today]
    if len(dropped):
        print(f"  Bitmemiş hafta çıkarıldı: {', '.join(dropped['d'].dt.strftime('%d.%m.%Y'))}")
    base = base[base["d"] <= today].reset_index(drop=True)
    # Faiz serilerindeki ara boşluklar doğrusal doldurulur; sondaki boşluklar boş bırakılır
    for c in RATE_CODES:
        base[c] = base[c].interpolate(limit_area="inside")

    cpi = cpi.sort_values("Tarih").reset_index(drop=True)

    # Politika faizi (isteğe bağlı, aylık, ay sonu değeri): her hafta, o ayın başında geçerli
    # olan oranı (bir önceki ayın ay sonu değerini) alır; karar tarihinden önce gösterilmez
    pol = None
    if policy is not None:
        pol = policy[["Tarih", POLICY_CODE]].dropna().sort_values("Tarih").reset_index(drop=True)
        pmap = dict(zip(pol["Tarih"], pol[POLICY_CODE]))
        base["POLITIKA_FAIZI"] = (base["d"].dt.to_period("M") - 1).astype(str).map(pmap)

    def arr(s, nd=6):
        return [None if pd.isna(v) else round(float(v), nd) for v in s]

    def last_date(col):
        return base.loc[base[col].last_valid_index(), "d"].strftime("%Y-%m-%d")

    data = {
        "meta": {
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "files": used,
            "last": {
                "rates": last_date("TP_TRY_MT06"),
                "fx": base["d"].iloc[-1].strftime("%Y-%m-%d"),
                "gold": last_date("XAU"),
                "tufe": cpi.loc[cpi[CPI_CODES["tufe"]].last_valid_index(), "Tarih"],
                "ufe": cpi.loc[cpi[CPI_CODES["ufe"]].last_valid_index(), "Tarih"],
                "policy": pol["Tarih"].iloc[-1] if pol is not None else None,
            },
        },
        "weeks": base["d"].dt.strftime("%Y-%m-%d").tolist(),
        "rates": {c[-4:]: arr(base[c], 4) for c in RATE_CODES},
        "fx": {
            **{cur: {"buy": arr(base[a]), "sell": arr(base[s])} for cur, (a, s) in FX_CODES.items()},
            "XAU": {"buy": arr(base["XAU"], 4), "sell": arr(base["XAU"], 4)},
        },
        "cpi": {
            "months": cpi["Tarih"].tolist(),
            "tufe": arr(cpi[CPI_CODES["tufe"]], 4),
            "ufe": arr(cpi[CPI_CODES["ufe"]], 4),
        },
        "stopaj": stopaj,
        "policy": {"months": pol["Tarih"].tolist(), "rate": arr(pol[POLICY_CODE], 4)} if pol is not None else None,
    }
    OUT_JSON.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    out = base.rename(columns={"d": "tarih", "XAU": "XAU_TRY_GRAM"})
    out["tarih"] = out["tarih"].dt.strftime("%Y-%m-%d")
    # Türkçe Excel ile uyumlu CSV: noktalı virgül ayraç, virgül ondalık, UTF-8 BOM
    out.to_csv(OUT_CSV, index=False, sep=";", decimal=",", encoding="utf-8-sig")

    m = data["meta"]["last"]
    print(f"OK: {len(data['weeks'])} hafta ({data['weeks'][0]} -> {data['weeks'][-1]})")
    print(f"    Son veri: faiz {m['rates']}, kur {m['fx']}, altın {m['gold']}, TÜFE {m['tufe']}, ÜFE {m['ufe']}")
    print(f"    Stopaj: {len(stopaj)} dönem")
    print(f"    Politika faizi: {'son ay ' + m['policy'] if m.get('policy') else 'dosya yok (isteğe bağlı)'}")
    print(f"    Yazıldı: data/dataset.json, data/dataset.csv")


if __name__ == "__main__":
    main()
