import { route } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { getScanner } from "@/server/services/scanner";

export const POST = route(async ({ req }) => {
  const form = await req.formData().catch(() => null);
  const file = form?.get("image");
  if (!(file instanceof File) || !file.type.startsWith("image/")) throw new AppError("Please choose a photo to scan.");
  if (file.size > 6_000_000) throw new AppError("That photo is too large. Try one under 6 MB.");
  return getScanner().scan(Buffer.from(await file.arrayBuffer()), file.type);
});
