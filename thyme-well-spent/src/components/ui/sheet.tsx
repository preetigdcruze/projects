"use client";
import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Bottom sheet on mobile, centred dialog on desktop. Swipe the handle down to dismiss. */
export function Sheet({ open, onOpenChange, title, description, children, className }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={description ? undefined : undefined}>
              <motion.div
                className={cn("fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92dvh] w-full max-w-xl flex-col rounded-t-3xl bg-card shadow-lift outline-none md:inset-auto md:left-1/2 md:top-1/2 md:max-h-[88dvh] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-3xl", className)}
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={{ type: "spring", damping: 32, stiffness: 380 }}
                drag="y" dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0, bottom: 0.6 }} dragListener={false}
                onDragEnd={(_, i) => { if (i.offset.y > 120 || i.velocity.y > 600) onOpenChange(false); }}
              >
                <DragHandle onClose={() => onOpenChange(false)} />
                <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-1 md:pt-5">
                  <div>
                    <Dialog.Title className="font-display text-xl font-semibold">{title}</Dialog.Title>
                    {description ? <Dialog.Description className="mt-1 text-sm text-muted-foreground">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
                  </div>
                  <Dialog.Close className="tap -mr-2 -mt-1 flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label="Close"><X className="h-5 w-5" /></Dialog.Close>
                </div>
                <div className="overflow-y-auto overscroll-contain px-5 pb-safe pt-2">{children}</div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function DragHandle({ onClose }: { onClose: () => void }) {
  return <div className="flex justify-center pb-1 pt-3 md:hidden" aria-hidden onClick={onClose}><div className="h-1.5 w-10 rounded-full bg-border" /></div>;
}
