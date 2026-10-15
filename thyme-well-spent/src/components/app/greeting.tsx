"use client";
import { useEffect, useState } from "react";
import { greeting } from "@/lib/dates";

/** Greeting uses the viewer's local clock; the server date can differ from the user's timezone. */
export function Greeting({ name }: { name: string }) {
  const [text, setText] = useState("Hello");
  useEffect(() => setText(greeting(new Date().getHours())), []);
  return <h1 className="text-[28px] font-semibold leading-tight md:text-4xl">{text}, {name}</h1>;
}
