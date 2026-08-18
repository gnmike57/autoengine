const fs = require('fs');

let css = fs.readFileSync('public/css/style.css', 'utf8');

// 1. Backgrounds
// Let's add a subtle radial gradient to the body via a pseudo-element for depth
const bgInject = `
    body::before {
      content: '';
      position: fixed;
      top: -50%; left: -50%;
      width: 200%; height: 200%;
      background: radial-gradient(circle at center, rgba(6, 182, 212, 0.05) 0%, transparent 40%),
                  radial-gradient(circle at 80% 20%, rgba(239, 68, 68, 0.03) 0%, transparent 30%);
      pointer-events: none;
      z-index: -1;
      animation: bgPulse 20s ease-in-out infinite alternate;
    }
    @keyframes bgPulse {
      0% { transform: scale(1) translate(0, 0); }
      100% { transform: scale(1.1) translate(-2%, 2%); }
    }
`;
if (!css.includes('body::before')) {
  css = css.replace('body {', bgInject + '\n    body {');
}

// 2. Custom Neon Scrollbars
css = css.replace(/::-webkit-scrollbar-thumb \{[^}]+\}/, `::-webkit-scrollbar-thumb {
      background: rgba(6, 182, 212, 0.2);
      border-radius: 4px;
      border: 1px solid rgba(6, 182, 212, 0.1);
    }`);
css = css.replace(/::-webkit-scrollbar-thumb:hover \{[^}]+\}/, `::-webkit-scrollbar-thumb:hover {
      background: rgba(6, 182, 212, 0.5);
      box-shadow: 0 0 10px rgba(6, 182, 212, 0.5);
    }`);
css = css.replace('::-webkit-scrollbar {\n      width: 5px;\n      height: 5px;\n    }', '::-webkit-scrollbar {\n      width: 6px;\n      height: 6px;\n    }');

// 3. Typography
css = css.replace(/h1,\s*h2,\s*h3,\s*h4,\s*\.stat-val \{/, `h1, h2, h3, h4, .stat-val {
      letter-spacing: 0.5px;
      text-shadow: 0 2px 4px rgba(0,0,0,0.5);`);

// 4. Enhanced Glass Panels
css = css.replace('backdrop-filter: blur(16px);\n      -webkit-backdrop-filter: blur(16px);', 
                  'backdrop-filter: blur(24px);\n      -webkit-backdrop-filter: blur(24px);');
css = css.replace('box-shadow: 0 12px 40px 0 rgba(0, 0, 0, 0.5);', 
                  'box-shadow: 0 12px 40px rgba(0, 0, 0, 0.7), 0 0 20px rgba(6, 182, 212, 0.15);');

// 5. Button Animations
if (!css.includes('@keyframes btnPulse')) {
  css = css.replace('.btn-start {', 
    `@keyframes btnPulse {
      0% { box-shadow: 0 0 10px rgba(220, 38, 38, 0.4), inset 0 0 5px rgba(255,255,255,0.2); }
      50% { box-shadow: 0 0 20px rgba(220, 38, 38, 0.7), inset 0 0 10px rgba(255,255,255,0.4); }
      100% { box-shadow: 0 0 10px rgba(220, 38, 38, 0.4), inset 0 0 5px rgba(255,255,255,0.2); }
    }
    .btn-start {
      animation: btnPulse 3s infinite;
      position: relative;
      overflow: hidden;`);
}

// 6. Nav Tabs
// Let's add a glowing pseudo element under the active tab
if (!css.includes('.nav-tab.active::after')) {
  css = css.replace('.nav-tab.active {', 
  `.nav-tab { position: relative; }
   .nav-tab::after {
      content: '';
      position: absolute;
      bottom: -2px; left: 10%; width: 80%; height: 2px;
      background: var(--cyan);
      box-shadow: 0 0 8px var(--cyan);
      opacity: 0;
      transition: all 0.3s var(--ease);
      border-radius: 2px;
   }
   .nav-tab.active::after { opacity: 1; bottom: 0px; }
   .nav-tab.active { text-shadow: 0 0 8px rgba(6,182,212,0.6); `);
}

// 7. Stat Cards translation
css = css.replace('transform: translateY(-3px) scale(1.02);', 'transform: translateY(-5px) scale(1.03);');

// 8. Result Tile translation
css = css.replace('transform: translateY(-2px);', 'transform: translateY(-4px); box-shadow: 0 8px 24px rgba(6,182,212,0.15);');

// 9. Cyber Switch Toggles
css = css.replace('.cyber-switch input:checked + .cyber-slider {', 
  `.cyber-switch input:checked + .cyber-slider {
      box-shadow: inset 0 0 8px rgba(0,0,0,0.5), 0 0 10px rgba(6, 182, 212, 0.4);`);

// 10. CRT Terminal and Hermes text shadows
css = css.replace('.log-body {', '.log-body {\n      text-shadow: 0 0 4px rgba(52, 211, 153, 0.5);');
css = css.replace('.hermes-log-feed {', '.hermes-log-feed {\n      text-shadow: 0 0 3px rgba(6, 182, 212, 0.4);');
css = css.replace('.hl-level {', '.hl-level {\n      text-shadow: 0 0 4px currentColor;');

fs.writeFileSync('public/css/style.css', css, 'utf8');
console.log("Premium CSS updates applied.");
