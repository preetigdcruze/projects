export const GOALS = [
  { value: "lose_weight", label: "Lose weight", emoji: "🎯" }, { value: "maintain", label: "Maintain weight", emoji: "⚖️" }, { value: "gain_muscle", label: "Gain muscle", emoji: "💪" },
  { value: "eat_healthier", label: "Eat healthier", emoji: "🥗" }, { value: "energy", label: "Improve energy", emoji: "⚡" }, { value: "build_habits", label: "Build better eating habits", emoji: "🌱" },
  { value: "save_time", label: "Save time", emoji: "⏱️" }, { value: "save_money", label: "Save money", emoji: "💸" },
] as const;

export const CUISINE_OPTIONS = [
  { value: "Indian", emoji: "🍛" }, { value: "Italian", emoji: "🍝" }, { value: "Mexican", emoji: "🌮" }, { value: "Thai", emoji: "🍜" },
  { value: "Mediterranean", emoji: "🥙" }, { value: "Japanese", emoji: "🍣" }, { value: "American", emoji: "🍔" }, { value: "Middle Eastern", emoji: "🧆" },
] as const;

export const LOVED_INGREDIENTS = ["chicken", "paneer", "eggs", "salmon", "tofu", "lentils", "chickpeas", "rice", "pasta", "avocado", "spinach", "potato"];

export const COOK_TIMES = [
  { value: 15, label: "10–15 minutes" }, { value: 30, label: "15–30 minutes" }, { value: 45, label: "30–45 minutes" }, { value: 60, label: "45–60 minutes" }, { value: 120, label: "I enjoy cooking" },
] as const;

export const ACTIVITY = [
  { value: "sedentary", label: "Mostly sitting" }, { value: "light", label: "Lightly active" }, { value: "moderate", label: "Moderately active" }, { value: "active", label: "Very active" }, { value: "very_active", label: "Athlete level" },
] as const;

export const MEAL_OPTIONS = [{ value: "breakfast", label: "Breakfast" }, { value: "lunch", label: "Lunch" }, { value: "snack", label: "Snacks" }, { value: "dinner", label: "Dinner" }] as const;
