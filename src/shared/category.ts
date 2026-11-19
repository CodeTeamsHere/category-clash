// Category content model. Each category is an editorial list of accepted answers.
// Tier is a hand-picked rarity: 1 = everyone says it, 5 = deep cut.

export type Tier = 1 | 2 | 3 | 4 | 5;

export interface CategoryAnswer {
  canonical: string;
  aliases?: string[];
  tier: Tier;
}

export interface Category {
  id: string;
  prompt: string;
  tags?: string[];
  answers: CategoryAnswer[];
}

export const TIER_POINTS: Record<Tier, number> = { 1: 10, 2: 20, 3: 40, 4: 70, 5: 100 };
export const TIER_NAMES: Record<Tier, string> = { 1: "Common", 2: "Solid", 3: "Sharp", 4: "Rare", 5: "Legendary" };
