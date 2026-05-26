import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  CHARACTER_VARIANTS,
  InteractiveCharacter,
  VARIANT_LABELS,
} from "@/components/ui/interactive-3d-character";
import type { CharacterVariant } from "@/components/ui/interactive-3d-character";

export const Route = createFileRoute("/characters")({
  component: CharactersPage,
  head: () => ({ meta: [{ title: "Characters - Fleet Invaders" }] }),
});

function CharactersPage() {
  const [focused, setFocused] = useState<CharacterVariant>("happy");

  return (
    <main className="characters-page">
      <div className="aurora-background" aria-hidden>
        <div className="aurora-blob" />
        <div className="aurora-blob" />
        <div className="aurora-blob" />
      </div>

      <div className="characters-content">
        <h1 className="characters-title">TOURNAMENT CHARACTERS</h1>
        <p className="characters-sub">
          Six upbeat Zdog avatars with mouse tracking, breathing, and custom blink timing.
        </p>

        <section className="character-spotlight" aria-label={`${VARIANT_LABELS[focused]} preview`}>
          <div className="character-spotlight-canvas">
            <InteractiveCharacter variant={focused} />
          </div>
          <div className="character-spotlight-label">{VARIANT_LABELS[focused]}</div>
        </section>

        <div className="characters-grid" aria-label="Character variants">
          {CHARACTER_VARIANTS.map((variant) => (
            <button
              key={variant}
              className={`character-card ${focused === variant ? "character-card--active" : ""}`}
              onClick={() => setFocused(variant)}
              type="button"
            >
              <div className="character-card-canvas">
                <InteractiveCharacter variant={variant} />
              </div>
              <span className="character-card-label">{VARIANT_LABELS[variant]}</span>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
