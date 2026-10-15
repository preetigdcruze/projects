import Image from "next/image";
import { FoodArt } from "./food-art";
import { cn } from "@/lib/utils";

export function FoodImage({ title, cuisine, image, className, emojiClass, sizes = "(max-width: 768px) 50vw, 320px", priority }: {
  title: string; cuisine: string; image?: string | null; className?: string; emojiClass?: string; sizes?: string; priority?: boolean;
}) {
  if (image) {
    return (
      <div className={cn("relative overflow-hidden", className)}>
        <Image src={image} alt={title} fill sizes={sizes} className="object-cover" priority={priority} />
      </div>
    );
  }
  return <FoodArt title={title} cuisine={cuisine} className={className} emojiClass={emojiClass} />;
}
