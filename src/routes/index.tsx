import { createFileRoute } from "@tanstack/react-router";
import { Component as StarshipShader } from "@/components/ui/starship-shader";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "Fleet Invaders - Fleet Zero Production" },
      {
        name: "description",
        content:
          "Neon arcade shooter from the Fleet Zero Production fleet maintenance division. Defend the garage across six waves, then enter Overdrive.",
      },
      { property: "og:title", content: "Fleet Invaders - Fleet Zero Production" },
      {
        property: "og:description",
        content: "Neon arcade shooter. Defend the fleet, beat the Broken Elevator, enter Overdrive.",
      },
    ],
  }),
});

function Index() {
  return (
    <main className="fixed inset-0 bg-black overflow-hidden">
      <h1 className="sr-only">Fleet Invaders - Fleet Zero Production arcade shooter</h1>

      <div className="absolute inset-0 z-0">
        <StarshipShader />
      </div>

      <iframe
        src="/game.html"
        title="Fleet Invaders"
        className="absolute inset-0 h-full w-full border-0 z-10"
        allow="autoplay; gamepad; fullscreen"
        style={{ background: "transparent" }}
      />
    </main>
  );
}
