// 打包前自动递增 patch 版本号，并生成 build-version.json 供界面显示
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const parts = pkg.version.split('.').map((n) => parseInt(n, 10) || 0);
pkg.version = `${parts[0]}.${parts[1]}.${(parts[2] || 0) + 1}`;

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(root, 'build-version.json'), JSON.stringify({ version: pkg.version }), 'utf8');
console.log(`version bumped -> ${pkg.version}`);
