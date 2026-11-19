import type { Category } from "../shared/category";
import africanCountries from "./categories/african-countries.json";
import ballSports from "./categories/ball-sports.json";
import dogBreeds from "./categories/dog-breeds.json";
import fruits from "./categories/fruits.json";
import instruments from "./categories/instruments.json";
import oceanAnimals from "./categories/ocean-animals.json";
import pizzaToppings from "./categories/pizza-toppings.json";
import vegetables from "./categories/vegetables.json";

// Add new category files here. src/content/content.test.ts validates every entry.
export const CATEGORIES: Category[] = [
  africanCountries,
  ballSports,
  dogBreeds,
  fruits,
  instruments,
  oceanAnimals,
  pizzaToppings,
  vegetables,
] as Category[];

const byId = new Map(CATEGORIES.map((c) => [c.id, c]));

export function getCategory(id: string): Category | undefined {
  return byId.get(id);
}
