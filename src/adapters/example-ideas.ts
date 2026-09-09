import type { Idea } from '../domain/research.ts';
/** Curated design fixtures. These are hypotheses, not live discoveries or verified novelty claims. */
export const exampleIdeas: readonly Idea[] = [
  {
    id: 'optimizer-transfer',
    title: 'Does an optimizer gain survive a change in scale?',
    area: 'Efficient training',
    question:
      'Do small-model optimizer improvements persist under a fixed wall-clock budget at a second model size?',
    rationale:
      'Separate a useful training improvement from a configuration-specific speedup.',
    sourceTitle: 'Karpathy / autoresearch',
    sourceUrl: 'https://github.com/karpathy/autoresearch',
    confounder:
      'Compilation overhead, hardware differences, and tuning on the evaluation set can reverse the apparent gain.',
  },
  {
    id: 'memory-ablation',
    title: 'Which memories actually help a research agent?',
    area: 'Agent systems',
    question:
      'Does evidence-linked memory reduce repeated failed experiments compared with a rolling text summary?',
    rationale:
      'Measure progress per dollar and duplicate attempts, alongside task success.',
    sourceTitle: 'NVIDIA / NOOA',
    sourceUrl: 'https://github.com/NVIDIA-NeMo/labs-OO-Agents',
    confounder:
      'Context length and extra supervisor calls may explain the improvement rather than memory structure.',
  },
  {
    id: 'gating-study',
    title: 'Can a cheap pilot identify ideas worth executing?',
    area: 'Research evaluation',
    question:
      'Does baseline-first pilot screening improve the fraction of ideas that survive fresh-seed confirmation?',
    rationale:
      'Test the central Verifold premise under a fixed total budget, retaining negative results.',
    sourceTitle: 'The Ideation-Execution Gap',
    sourceUrl: 'https://arxiv.org/abs/2506.20803',
    confounder:
      'Selecting only successful pilots introduces selection bias; compare complete idea cohorts.',
  },
];
