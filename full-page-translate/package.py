"""打包发布用 zip：只包含扩展运行所需文件，不含 secret.properties。用法：python package.py"""
import json, zipfile, pathlib

root = pathlib.Path(__file__).parent
version = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["version"]
FILES = [
    "manifest.json", "background.js", "content.js", "content.css", "defaults.js",
    "options.html", "options.js", "popup.html", "popup.js", "ui.css",
    "README.md", "secret.properties.example",
    "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png",
]
out = root / "dist" / f"DeepTranslate-{version}.zip"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in FILES:
        z.write(root / f, f"DeepTranslate/{f}")
print(out)
