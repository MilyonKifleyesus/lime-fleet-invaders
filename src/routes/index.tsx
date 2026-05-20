import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "Fleet Invaders — Bus Pulse" },
      { name: "description", content: "Neon arcade shooter from the Bus Pulse fleet maintenance division. Defend the garage across six waves, then enter Overdrive." },
      { property: "og:title", content: "Fleet Invaders — Bus Pulse" },
      { property: "og:description", content: "Neon arcade shooter. Defend the fleet, beat the Broken Elevator, enter Overdrive." },
    ],
  }),
});

function Index() {
  return (
    <main className="fixed inset-0 bg-black">
      <h1 className="sr-only">Fleet Invaders — Bus Pulse arcade shooter</h1>
      <iframe
        src="/game.html"
        title="Fleet Invaders"
        className="h-full w-full border-0"
        allow="autoplay; gamepad; fullscreen"
      />
    </main>
  );
}
