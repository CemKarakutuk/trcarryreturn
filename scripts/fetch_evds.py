#!/usr/bin/env python3
"""
TCMB EVDS web servisinden veriyi çeker ve data/raw/ altındaki Excel dosyalarını
yeniler. Ardından scripts/update_data.py çalıştırılarak dataset dosyaları üretilir.

Kullanım (repo kök dizininde):
    export EVDS_API_KEY=xxxxxxxx      # Windows: set EVDS_API_KEY=xxxxxxxx
    python scripts/fetch_evds.py
    python scripts/update_data.py

GitHub Actions bu iki komutu haftalık olarak kendisi çalıştırır; anahtar
EVDS_API_KEY adlı repository secret'ından okunur.

Yenilenen dosyalar:
    data/raw/mevduat_faiz.xlsx    TP.TRY.MT01–MT06        (haftalık)
    data/raw/doviz_kurlari.xlsx   TP.DK.{USD,EUR,GBP}     (haftalık)
    data/raw/enflasyon.xlsx       TÜFE ve Yİ-ÜFE          (aylık)
    data/raw/politika_faizi.xlsx  TP.BISPOLFAIZ.TUR       (aylık)

Elle güncellenmeye devam eden dosyalar:
    data/raw/gram_altin.xlsx      ICE XAU/TRY (EVDS'de yok)
    data/raw/stopaj.xlsx          Resmî Gazete kararları
"""
import os
import re
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
# EVDS web servisi evds3'e taşındı; eski adres HTML ana sayfaya yönleniyor.
# Sırayla denenir, çalışan adres sonraki isteklerde doğrudan kullanılır.
ENDPOINTS = [
    "https://evds3.tcmb.gov.tr/igmevdsms-dis/",
    "https://evds2.tcmb.gov.tr/service/evds/",
]
_working_endpoint = None
START = "01-01-2002"

# EVDS frekans kodları: 1 günlük, 2 iş günü, 3 haftalık, 5 aylık
WEEKLY, MONTHLY = 3, 5

# Günlük serilerin haftalığa çevrilme biçimi. Mevcut veri seti "avg" (haftalık
# aritmetik ortalama) ile üretildiği için varsayılan budur; "last" (hafta sonu
# son gözlem) yayımlanmış rakamları değiştirir, bilinçli olarak seçilmelidir.
AGGREGATION = "avg"

# [çıktı dosyası, seri kodları, frekans, minimum beklenen satır]
JOBS = [
    ("mevduat_faiz.xlsx", [f"TP.TRY.MT0{i}" for i in range(1, 7)], WEEKLY, 1200),
    ("doviz_kurlari.xlsx", [f"TP.DK.{c}.{s}.YTL" for c in ("USD", "EUR", "GBP") for s in ("A", "S")], WEEKLY, 1200),
    ("enflasyon.xlsx", ["TP.GENENDEKS.T1", "TP.TUFE1YI.T1"], MONTHLY, 280),
    ("politika_faizi.xlsx", ["TP.BISPOLFAIZ.TUR"], MONTHLY, 280),
]


def friday_of_week(d):
    """Haftalık gözlemi, ait olduğu haftanın cumasına sabitler.

    EVDS haftayı bazı serilerde hafta başı, bazılarında hafta sonu tarihiyle
    etiketleyebiliyor. Hepsini cumaya çekince seriler birbiriyle ve altın
    verisiyle aynı takvime oturur (update_data.py altını da cumaya çeker).
    """
    return d - timedelta(days=d.weekday()) + timedelta(days=4)


def parse_date(raw):
    """EVDS'nin döndürdüğü tarihi datetime.date'e çevirir."""
    s = str(raw).strip()
    for fmt in ("%d-%m-%Y", "%Y-%m-%d", "%d.%m.%Y", "%Y-%m", "%m-%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    m = re.match(r"^(\d{4})-(\d{1,2})$", s)          # "2002-1" gibi aylık biçim
    if m:
        return date(int(m.group(1)), int(m.group(2)), 1)
    raise ValueError(f"Tanınmayan tarih biçimi: {raw!r}")


def fetch(series, frequency, key):
    """Tek bir EVDS isteği. Çalışan uç noktayı bulana kadar sırayla dener."""
    global _working_endpoint
    query = (f"series={'-'.join(series)}&startDate={START}"
             f"&endDate={date.today().strftime('%d-%m-%Y')}"
             f"&type=json&frequency={frequency}&aggregationTypes={AGGREGATION}")
    bases = [_working_endpoint] if _working_endpoint else ENDPOINTS
    errors = []
    for base in bases:
        try:
            items = request_once(base + query, key)
            if _working_endpoint != base:
                print(f"  uç nokta: {base}")
                _working_endpoint = base
            return items
        except Exception as e:
            errors.append(f"{base} -> {e}")
    raise SystemExit("EVDS isteği başarısız.\n  " + "\n  ".join(errors))


class Fatal(Exception):
    """Yeniden denemenin işe yaramayacağı yanıt (yanlış adres, HTML gövde…)."""


def request_once(url, key):
    """Tek adrese istek; geçici ağ hatasında iki kez yeniden dener."""
    last_error = None
    headers = {
        "key": key,
        "Accept": "application/json",
        # Bazı TCMB uç noktaları tarayıcı başlığı olmayan isteklere HTML sayfa döndürüyor
        "User-Agent": "Mozilla/5.0 (compatible; trcarryreturn-data-bot)",
    }
    for attempt in range(3):
        try:
            # allow_redirects=False: yönlendirme izlenirse 'key' başlığı başka bir
            # sunucuya gidebilir. Yönlendirme gelirse adres yanlış demektir.
            r = requests.get(url, headers=headers, timeout=120, allow_redirects=False)
            if r.is_redirect or r.status_code in (301, 302, 303, 307, 308):
                raise Fatal(f"yönlendirme ({r.status_code} -> {r.headers.get('location', '?')})")
            if r.status_code == 401:
                sys.exit("EVDS anahtarı reddedildi (401). EVDS_API_KEY değerini kontrol edin.")
            r.raise_for_status()
            try:
                payload = r.json()
            except ValueError:
                # 200 döndü ama gövde JSON değil: ne geldiğini log'a yaz
                body = " ".join(r.text.split())[:400] or "(boş gövde)"
                raise Fatal(
                    f"JSON değil | HTTP {r.status_code} "
                    f"| content-type: {r.headers.get('content-type', '?')} "
                    f"| gövde: {body}")
            items = payload.get("items")
            if not items:
                raise ValueError(f"EVDS boş yanıt döndürdü: {str(payload)[:300]}")
            return items
        except Fatal:                                  # yeniden denemenin anlamı yok
            raise
        except Exception as e:                        # geçici ağ/JSON hatası
            last_error = e
            if attempt < 2:
                time.sleep(3 * (attempt + 1))
    raise ValueError(last_error)


def build_frame(items, series, frequency):
    """EVDS yanıtını, elle indirilen Excel çıktısıyla aynı biçime getirir."""
    cols = [s.replace(".", "_") for s in series]
    rows = []
    for it in items:
        try:
            d = parse_date(it.get("Tarih"))
        except ValueError:
            continue                                   # tarih olmayan satırları atla
        label = (friday_of_week(d).strftime("%d-%m-%Y") if frequency == WEEKLY
                 else d.strftime("%Y-%m"))
        row = {"Tarih": label}
        for c in cols:
            v = it.get(c)
            row[c] = "" if v in (None, "", "null") else str(v).strip()
        rows.append(row)

    df = pd.DataFrame(rows, columns=["Tarih"] + cols)
    missing = [c for c in cols if c not in df.columns or (df[c] == "").all()]
    if missing:
        print(f"  ! uyarı: veri gelmeyen seri(ler): {', '.join(missing)}")
    # Aynı tarihe düşen satırlar (frekans dönüşümü sonrası) tekilleştirilir
    df = df.drop_duplicates(subset="Tarih", keep="last")
    df["_s"] = df["Tarih"].map(parse_date)
    return df.sort_values("_s").drop(columns="_s").reset_index(drop=True)


def existing_rows(path):
    if not path.exists():
        return 0
    try:
        old = pd.read_excel(path, dtype=str)
        return int(old["Tarih"].astype(str).str.match(r"^\d").sum())
    except Exception:
        return 0


def main():
    key = os.environ.get("EVDS_API_KEY", "").strip()
    if not key:
        sys.exit("EVDS_API_KEY tanımlı değil. Anahtarı ortam değişkeni olarak verin "
                 "(GitHub'da repository secret).")
    RAW.mkdir(parents=True, exist_ok=True)

    for filename, series, frequency, floor in JOBS:
        print(f"{filename}: {len(series)} seri indiriliyor…")
        df = build_frame(fetch(series, frequency, key), series, frequency)
        path = RAW / filename

        # Güvenlik freni: eksik yanıt, sağlam veriyi ezmesin
        old_n = existing_rows(path)
        if len(df) < max(floor, int(old_n * 0.9)):
            sys.exit(f"  ! {filename} için beklenenden az satır geldi "
                     f"({len(df)}, mevcut {old_n}). Dosya değiştirilmedi.")

        df.to_excel(path, index=False)
        print(f"  {len(df)} satır: {df['Tarih'].iloc[0]} → {df['Tarih'].iloc[-1]}")

    print("\nEVDS dosyaları güncellendi. Sırada: python scripts/update_data.py")
    print("Not: gram_altin.xlsx ve stopaj.xlsx elle güncellenir.")


if __name__ == "__main__":
    main()
