#!/usr/bin/env python3
"""Build an unsigned Tizen widget on Windows/macOS/Linux with the standard library."""
import re
import secrets
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
OUT = ROOT / 'dist' / 'arn0-launcher.wgt'


def include(path):
    parts = path.parts
    if any(part.startswith('.') for part in parts):
        return False
    if path.suffix.lower() in {'.p12', '.pfx', '.pem', '.key', '.cer', '.crt', '.wgt', '.tpk'}:
        return False
    if parts[:2] in {('img', 'marks'), ('img', 'easter-egg')} or parts[0] == 'audio':
        return False
    return path.name not in {'config.local.example.js', 'author-signature.xml', 'signature1.xml'}


def build():
    # Existing build tools generate the icon and coloured SVGs without third-party packages.
    if not (SRC / 'icon.png').exists():
        subprocess.run(['node', str(ROOT / 'scripts' / 'make-icon.mjs')], cwd=ROOT, check=True)
    subprocess.run(['node', str(ROOT / 'scripts' / 'build-marks.mjs')], cwd=ROOT, check=True)
    manifest = ET.parse(SRC / 'config.xml').getroot()
    app = manifest.find('{http://tizen.org/ns/widgets}application')
    if app is None or app.attrib.get('required_version') != '4.0':
        raise ValueError('NU7093 package must target Tizen 4.0')
    OUT.parent.mkdir(exist_ok=True)
    # Build to a temporary file so a failed build cannot replace a working package.
    with tempfile.TemporaryDirectory(dir=OUT.parent) as folder:
        pending = Path(folder) / OUT.name
        token = secrets.token_hex(24)
        with zipfile.ZipFile(pending, 'w', compression=zipfile.ZIP_DEFLATED) as widget:
            widget.writestr('services/home-return-token.js', 'module.exports="' + token + '";\n')
            for source in sorted(SRC.rglob('*')):
                relative = source.relative_to(SRC)
                if source.is_file() and include(relative):
                    if relative.as_posix() == 'index.html':
                        html = source.read_text(encoding='utf-8')
                        if html.count('/* HOME_RETURN_TOKEN */') != 1:
                            raise ValueError('Missing Home return token placeholder')
                        widget.writestr('index.html', html.replace('/* HOME_RETURN_TOKEN */', 'window.ARN0_HOME_TOKEN="' + token + '";'))
                    elif relative.as_posix() != 'services/home-return-token.js':
                        widget.write(source, relative.as_posix())
            if not (SRC / 'js' / 'config.local.js').exists():
                widget.writestr('js/config.local.js', '/* No local overrides. */\n')
        with zipfile.ZipFile(pending) as widget:
            if widget.testzip() is not None:
                raise ValueError('Widget integrity check failed')
            html = widget.read('index.html').decode('utf-8')
            for reference in re.findall(r'(?:src|href)="([^"#]+)"', html):
                if '://' not in reference and reference not in widget.namelist():
                    raise ValueError('Missing runtime file: ' + reference)
        pending.replace(OUT)
    print('Built unsigned widget:', OUT)
    print('Sign using a Samsung TV certificate before installing. No TV was contacted.')


if __name__ == '__main__':
    try:
        build()
    except (OSError, ValueError, subprocess.CalledProcessError, ET.ParseError) as error:
        print('Build failed:', error, file=sys.stderr)
        sys.exit(1)
