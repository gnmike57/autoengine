const fs = require('fs');

// 1. Fix CSS
let css = fs.readFileSync('public/css/style.css', 'utf8');
css = css.replace('object-fit: contain;\n      display: block;\n      height: 100%;\n      object-fit: contain;', 'object-fit: cover;\n      object-position: center top;\n      display: block;\n      height: 100%;');
// Make the card slightly larger (4:3 aspect ratio)
css = css.replace('width: 160px;\n      height: 98px;', 'width: 160px;\n      height: 120px;');
// Enhance table row hover
css = css.replace('tbody tr:hover { background: rgba(6, 182, 212, 0.04); }', 'tbody tr:hover { background: rgba(6, 182, 212, 0.15); box-shadow: inset 0 0 10px rgba(6,182,212,0.1); }');
// Make terminal log body use flex with column-reverse or just append.
// wait, if we change JS to append, no CSS change needed for log-body, just JS.
fs.writeFileSync('public/css/style.css', css, 'utf8');

// 2. Fix JS
let js = fs.readFileSync('public/js/app.js', 'utf8');
// Terminal auto-scroll: change prepend to appendChild and auto-scroll
js = js.replace('b.prepend(d); \n      if (b.children.length > 2000) b.lastChild.remove();',
`b.appendChild(d); 
      if (b.children.length > 2000) b.firstChild.remove();
      b.scrollTop = b.scrollHeight;`);

// Hermes auto-scroll: remove reverse() and add scroll
js = js.replace('feed.innerHTML = logs.slice().reverse().map(l => {', 
`feed.innerHTML = logs.map(l => {`);
js = js.replace('}).join(\'\');\n    }\n\n    function escHtml(s)', 
`}).join('');
      feed.scrollTop = feed.scrollHeight;
    }

    function escHtml(s)`);

fs.writeFileSync('public/js/app.js', js, 'utf8');

// 3. Fix HTML Analytics Chart
let html = fs.readFileSync('public/index.html', 'utf8');
html = html.replace('<div style="height: 300px; width: 100%;">\n        <canvas id="analyticsChart"></canvas>\n      </div>',
'<div style="height: 300px; width: 100%; position: relative;">\n        <canvas id="analyticsChart" style="max-height: 100%; max-width: 100%;"></canvas>\n      </div>');

fs.writeFileSync('public/index.html', html, 'utf8');

console.log("Aggressive UI fixes applied.");
