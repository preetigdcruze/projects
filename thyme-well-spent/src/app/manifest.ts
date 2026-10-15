import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Thyme Well Spent", short_name: "Thyme", description: "Meal planning, recipes, groceries and nutrition in one calm place.",
    start_url: "/", display: "standalone", background_color: "#FBF8F3", theme_color: "#2F5F49",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }, { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" }],
  };
}
