import type { Profile } from '../domain/profile.ts';
import type { Idea, Run } from '../domain/research.ts';
import { escapeHtml as e } from './dom.ts';

export function profileView(profile: Profile | null): string {
  return `<section class="intro"><p class="kicker">Your research profile</p><h1>Start with what<br>makes you curious.</h1><p>Connect your interests to a workspace for testable ideas and reproducible experiments.</p></section>
  <form id="profile-form" class="profile-form">
    <label>Your name<input name="name" required maxlength="80" value="${e(profile?.name ?? '')}" placeholder="Manav" autocomplete="name"></label>
    <label>What do you write, publish, or want to explore?<textarea name="interests" required maxlength="960" placeholder="Efficient training, agent systems, mechanistic interpretability">${e(profile?.interests.join(', ') ?? '')}</textarea><small>Separate areas with commas. You can describe any scientific interest; initial execution is scoped to computational ML.</small></label>
    <div class="form-grid"><label>Google Scholar <span>optional</span><input name="scholar" type="url" placeholder="https://scholar.google.com/citations?user=…" value="${e(profile?.scholar ?? '')}"></label><label>GitHub <span>optional</span><input name="github" type="url" placeholder="https://github.com/your-name" value="${e(profile?.github ?? '')}"></label></div>
    <label>Local coding session reference <span>optional</span><input name="session" maxlength="500" placeholder="A session title or export path to connect later" value="${e(profile?.session ?? '')}"><small>Saving a reference does not read local files or import your conversations.</small></label>
    <p class="note">Your profile is saved in this browser. Links are references; account connections are not active yet.</p>
    <button class="primary" type="submit">${profile ? 'Save profile' : 'Create profile'}</button>
  </form>`;
}

export function ideasView(profile: Profile, ideas: readonly Idea[]): string {
  return `<section class="intro"><p class="kicker">Research desk</p><h1>A direction worth<br>testing, ${e(profile.name.split(' ')[0] ?? profile.name)}.</h1><p>Follow a question from the literature to the evidence. A promising idea is the beginning of a run.</p></section>
    <div class="interests">${profile.interests.map((interest) => `<span>${e(interest)}</span>`).join('')}</div>
    <div class="section-heading"><h2>Research directions</h2><span>Curated examples · daily sync not connected</span></div>
    <div class="idea-list">${ideas.map((idea, index) => `<article class="idea"><div class="idea-number">${String(index + 1).padStart(2, '0')}</div><div><p class="kicker">${e(idea.area)}</p><h3>${e(idea.title)}</h3><p>${e(idea.question)}</p><a href="${e(idea.sourceUrl)}" target="_blank" rel="noreferrer">${e(idea.sourceTitle)} ↗</a></div><button data-idea="${e(idea.id)}">Explore idea</button></article>`).join('')}</div>
    <aside class="callout"><img src="/assets/verifold-symbol.webp" alt="" width="70" height="70"><div><h3>Keep the question. Follow the evidence.</h3><p>Every selected idea starts with a pilot plan. Findings remain exploratory until a separate confirmation run.</p></div></aside>`;
}

export function pilotView(idea: Idea): string {
  return `<button class="text-button" data-view="ideas">← Research directions</button><section class="intro"><p class="kicker">Exploratory pilot plan</p><h1>${e(idea.title)}</h1><p>${e(idea.rationale)}</p></section>
    <div class="pilot-layout"><form id="pilot-form"><h2>Define success before execution</h2><p>This draft is a planning exercise. No model analysis or experiment has run.</p>
    <label>Research purpose<select name="purpose"><option>R&D</option><option>Publication</option><option>Project</option></select></label>
    <label>Primary metric<input name="metric" required maxlength="160" placeholder="e.g. validation bits per byte"></label>
    <label>Comparison baseline<input name="baseline" required maxlength="300" placeholder="Repository commit + baseline configuration"></label>
    <div class="form-grid"><label>Direction<select name="direction"><option value="lower">Lower is better</option><option value="higher">Higher is better</option></select></label><label>Acceptance threshold<input name="threshold" type="number" step="any" required></label></div>
    <div class="form-grid"><label>Pilot budget (USD)<input name="budget" type="number" min="0.01" max="1000" step="0.01" value="10" required></label><label>Distinct seeds<input name="seeds" value="17, 29, 43" required></label></div>
    <label class="checkbox"><input name="approval" type="checkbox" required> I approve this exploratory planning contract.</label><button class="primary" type="submit">Lock pilot plan</button></form>
    <aside class="protocol"><h2>Before this earns more compute</h2><ol><li><strong>Reproduce the baseline</strong><p>Confirm code, dataset version, hardware, and evaluator agree.</p></li><li><strong>Test one change</strong><p>Use matched budgets, fresh seeds, and a relevant ablation.</p></li><li><strong>Inspect the failure modes</strong><p>${e(idea.confounder)}</p></li><li><strong>Design confirmation</strong><p>Use pilot variance to choose sample size and statistical analysis. Lock fresh holdouts before confirmation.</p></li></ol><p class="note">A threshold check alone does not establish statistical significance or independent verification.</p></aside></div>`;
}

export function runsView(runs: readonly Run[]): string {
  return `<section class="intro"><p class="kicker">Shared research hub · local preview</p><h1>The evidence<br>stays with the run.</h1><p>Track the contract, decisions, and findings in one place. Negative results belong here too.</p></section>
  ${runs.length ? runs.map((run) => `<article class="run"><div class="section-heading"><h2>${e(run.ideaId)}</h2><span class="badge">Awaiting execution adapter</span></div><p>${e(run.purpose)} · Approved by ${e(run.approvedBy)} · Budget $${run.criteria.budgetUsd}</p><dl><div><dt>Metric</dt><dd>${e(run.criteria.metric)}</dd></div><div><dt>Threshold</dt><dd>${run.criteria.direction === 'lower' ? '≤' : '≥'} ${run.criteria.threshold}</dd></div><div><dt>Seeds</dt><dd>${run.criteria.seeds.join(', ')}</dd></div><div><dt>Baseline</dt><dd>${e(run.criteria.baseline)}</dd></div></dl><ol class="timeline">${run.events.map((event) => `<li><strong>${e(event.kind)}</strong><p>${e(event.message)}</p><time>${e(event.at)}</time></li>`).join('')}</ol><button data-export="${e(run.id)}">Export run manifest</button><p class="note">Local session only. Export to keep this plan; shared storage and real-time agent events are not connected.</p></article>`).join('') : '<div class="empty"><h2>Your first run starts with a question.</h2><p>Select a direction and lock a pilot plan to create its evidence record.</p><button data-view="ideas">Explore research directions</button></div>'}`;
}

export function communityView(): string {
  return `<section class="intro"><p class="kicker">Community · planned</p><h1>Build on work<br>that holds up.</h1><p>A place to fork experiments, contribute a rerun, and discuss the evidence behind a claim.</p></section><div class="empty"><h2>Evidence first. Community next.</h2><p>Public run pages, fork lineage, and review by rerun are the first community primitives. This preview has no public submissions or fabricated activity.</p><p>Private research stays private until its owner explicitly chooses to share it.</p></div>`;
}
