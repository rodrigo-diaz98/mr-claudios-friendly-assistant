export const TICKET_ENTRY_SKILL = 'zero-to-shipped';

export const STAGE_SKILLS = {
  design: [TICKET_ENTRY_SKILL, 'grill-me', 'superpowers:brainstorming', 'superpowers:writing-plans'],
  build: ['superpowers:executing-plans', 'superpowers:subagent-driven-development'],
  review: ['simplify', 'look-for-bugs', 'code-review'],
  ship: ['open-nice-pr', 'ship-it'],
  feedback: ['review-pr-comments'],
};

export const TICKET_STAGES = Object.keys(STAGE_SKILLS);

export function stageOfSkill(skillName) {
  return TICKET_STAGES.find((stage) => STAGE_SKILLS[stage].includes(skillName)) ?? null;
}
