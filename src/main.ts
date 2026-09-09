import './style.css';
import { requiredElement } from './ui/dom.ts';
const app = requiredElement(document, '#app', HTMLDivElement);
app.innerHTML = `<div class="shell"><aside class="sidebar"><a class="brand" href="/" aria-label="Verifold home"><img src="/assets/verifold-horizontal.webp" alt="Verifold" width="184" height="46"></a><div class="sidebar-footer">Research beyond<br>the paper plane.</div></aside><div class="main-shell"><header><span>Your research, your harness</span><span class="badge">CLI preview</span></header><main id="workspace"><section class="intro"><p class="kicker">Verifold meta-harness</p><h1>Start in your<br>research workspace.</h1><p>Your CLI creates the profile, works with your existing AI harness, and asks which recommended idea you want to pursue. Research defaults private.</p></section><article class="run"><h2>Set up from the terminal</h2><pre>verifold init
verifold recommend
verifold ideas --from ideas.json
verifold select
verifold handoff
verifold view</pre><p>The host generates the recommendation file. Verifold presents its reasoning and proposed task-specific gates before you choose an idea. The handoff requests a pilot plan; it does not start compute.</p><p>Math, computer science, ML, security, and other research whose full experimental process runs on a computer.</p></article><aside class="callout"><img src="/assets/verifold-symbol.webp" alt="" width="70" height="70"><div><h3>The website is a view of your workspace.</h3><p>Run <code>verifold view</code> to generate a private local snapshot from CLI-managed state. Remote profile synchronization is not connected yet.</p></div></aside></main></div></div>`;
