"""Build the chapter files from the unchanged XML files supplied by Tanzil."""
import hashlib
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

DATA = Path(__file__).resolve().parents[1] / "tanzil"
TEXT_URL = "https://tanzil.net/pub/download/index.php?quranType=uthmani&outType=xml&marks=true&sajdah=true&tatweel=true&agree=true"
METADATA_URL = "https://tanzil.net/res/text/metadata/quran-data.xml"


def write_json(name, value):
    contents = json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
    (DATA / name).write_bytes(contents.encode("utf-8"))


def build(text_file, metadata_file):
    raw = text_file.read_bytes()
    metadata = metadata_file.read_bytes()
    notice = re.search(rb"<!--(.*?)-->", raw, re.S).group(1).decode("utf-8")
    assert "Uthmani, Version 1.1" in notice and "CHANGING IT IS NOT ALLOWED" in notice
    source = ET.fromstring(raw)
    catalog = ET.fromstring(metadata)
    suras = catalog.find("suras").findall("sura")
    assert len(source) == len(suras) == 114
    DATA.mkdir(exist_ok=True)
    chapters, corpus = [], []
    for index, (chapter, meta) in enumerate(zip(source, suras), 1):
        attrs = meta.attrib
        assert int(chapter.attrib["index"]) == int(attrs["index"]) == index
        ayahs = chapter.findall("aya")
        assert len(ayahs) == int(attrs["ayas"]) and int(attrs["start"]) == len(corpus)
        assert [int(a.attrib["index"]) for a in ayahs] == list(range(1, len(ayahs) + 1))
        text = [a.attrib["text"] for a in ayahs]
        basmala = ayahs[0].get("bismillah")
        assert bool(basmala) == (index not in (1, 9))
        assert not any(a.get("bismillah") for a in ayahs[1:])
        assert all(t and t == t.strip() and "  " not in t for t in text)
        corpus.extend(text)
        chapters.append(dict(id=index, en=attrs["tname"], ar=attrs["name"], tn=attrs["ename"], n=len(text)))
        name = f"{index}.json"
        write_json(name, dict(notice=notice, source="https://tanzil.net/", chapter=index, basmala=basmala, ayahs=text))
        decoded = json.loads((DATA / name).read_bytes())
        assert [t.encode("utf-8") for t in decoded["ayahs"]] == [a.attrib["text"].encode("utf-8") for a in ayahs]
        assert decoded["notice"] == notice and decoded["basmala"] == basmala
    assert len(corpus) == 6236
    assert json.loads((DATA / "2.json").read_bytes())["basmala"] == corpus[0]
    write_json("chapters.json", dict(source=METADATA_URL, copyright=catalog.attrib["copyright"],
                                     license=catalog.attrib["license"], chapters=chapters))
    (DATA / "NOTICE.txt").write_bytes(notice.encode("utf-8"))
    receipt = {"text": TEXT_URL, "text_sha256": hashlib.sha256(raw).hexdigest(),
               "metadata": METADATA_URL, "metadata_sha256": hashlib.sha256(metadata).hexdigest(),
               "license": "https://tanzil.net/docs/Text_License",
               "chapters": len(chapters), "ayahs": len(corpus), "unnumbered_opening_basmalas": 112,
               "numbered_text_utf8_lf_sha256": hashlib.sha256(("\n".join(corpus) + "\n").encode()).hexdigest()}
    write_json("source.json", receipt)
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    build(*map(Path, sys.argv[1:]))
