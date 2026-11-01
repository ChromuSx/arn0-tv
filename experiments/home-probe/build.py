from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.etree import ElementTree as ET
import secrets

root = Path(__file__).resolve().parent
repo = root.parents[1]
manifest = ET.parse(root / 'config.xml').getroot()
app = manifest.find('{http://tizen.org/ns/widgets}application')
assert app.attrib['id'] == 'Arn0Probe1.Probe'
out = repo / 'dist/arn0-home-probe.wgt'
out.parent.mkdir(exist_ok=True)
with ZipFile(out, 'w', ZIP_DEFLATED) as package:
    for name in ['config.xml', 'index.html', 'service.js', 'home-trial.js']:
        package.write(root / name, name)
    package.write(repo / 'src/icon.png', 'icon.png')
    token = secrets.token_hex(24)
    package.writestr('probe-token.js', '(function(root){var token="' + token + '";'
        'if(typeof module!=="undefined"&&module.exports){module.exports=token;}'
        'else{root.ARN0_PROBE_TOKEN=token;}})(this);\n')
print(out)
