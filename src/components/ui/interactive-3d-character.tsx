/* eslint-disable react-refresh/only-export-components */
import React, { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";

declare global {
  interface Window {
    Zdog?: ZdogApi;
    TweenMax?: GsapApi;
    TweenLite?: GsapApi;
    Sine?: { easeInOut: unknown; easeOut: unknown };
  }
}

type ZdogApi = {
  TAU: number;
  Illustration: new (options: Record<string, unknown>) => ZdogNode;
  Anchor: new (options: Record<string, unknown>) => ZdogNode;
  Group: new (options: Record<string, unknown>) => ZdogNode;
  Shape: new (options: Record<string, unknown>) => ZdogNode;
  Ellipse: new (options: Record<string, unknown>) => ZdogNode;
  Hemisphere: new (options: Record<string, unknown>) => ZdogNode;
};

type GsapApi = {
  to: (target: unknown, duration: number, vars: Record<string, unknown>) => GsapTween;
  killTweensOf: (target: unknown) => void;
};

type GsapTween = { kill: () => void };
type Vector = { x?: number; y?: number; z?: number };
type ZdogNode = {
  children: ZdogNode[];
  rotate: Required<Vector>;
  scale: Required<Vector>;
  translate: Required<Vector>;
  stroke?: number;
  updateRenderGraph?: () => void;
  copy: (options?: Record<string, unknown>) => ZdogNode;
  copyGraph: (options?: Record<string, unknown>) => ZdogNode;
};

export type CharacterVariant = "happy" | "excited" | "cool" | "sleepy" | "surprised" | "smirk";

type Palette = {
  skin: string;
  skinHighlight: string;
  skinShadow: string;
  accent: string;
  mouth: string;
  dark: string;
  light: string;
};

type CharacterModel = {
  head: ZdogNode;
  body: ZdogNode;
  bodyCore: ZdogNode;
  mouth: ZdogNode;
  eyes: ZdogNode[];
  idleTempo: number;
  blink: {
    minDelay: number;
    maxDelay: number;
    duration: number;
    closedScale: number;
  };
};

export const CHARACTER_VARIANTS: CharacterVariant[] = [
  "happy",
  "excited",
  "cool",
  "sleepy",
  "surprised",
  "smirk",
];

export const VARIANT_LABELS: Record<CharacterVariant, string> = {
  happy: "Happy",
  excited: "Excited",
  cool: "Cool",
  sleepy: "Sleepy",
  surprised: "Surprised",
  smirk: "Smirk",
};

export const EMOJI_TO_VARIANT: Record<string, CharacterVariant> = {
  "🚀": "excited",
  "👾": "cool",
  "🤖": "cool",
  "🦁": "excited",
  "🔥": "excited",
  "💀": "smirk",
  "🌙": "sleepy",
  "👽": "surprised",
  "🦄": "happy",
  "🐲": "excited",
  "⭐": "happy",
  "🎮": "cool",
  "💥": "excited",
  "🦊": "smirk",
  "🐸": "surprised",
  "🤠": "happy",
  "👻": "surprised",
  "🦅": "cool",
  "🏆": "happy",
  "⚡": "excited",
};

const SCENE_SIZE = 360;
const ZDOG_SRC = "https://unpkg.com/zdog@1/dist/zdog.dist.min.js";
const GSAP_SRC = "https://cdnjs.cloudflare.com/ajax/libs/gsap/2.1.3/TweenMax.min.js";

const PALETTES: Record<CharacterVariant, Palette> = {
  happy: {
    skin: "hsl(42, 92%, 68%)",
    skinHighlight: "hsl(42, 100%, 82%)",
    skinShadow: "hsl(32, 70%, 48%)",
    accent: "hsl(88, 92%, 52%)",
    mouth: "hsl(7, 70%, 33%)",
    dark: "#090400",
    light: "#fffdf2",
  },
  excited: {
    skin: "hsl(18, 95%, 64%)",
    skinHighlight: "hsl(18, 100%, 78%)",
    skinShadow: "hsl(4, 68%, 45%)",
    accent: "hsl(184, 98%, 55%)",
    mouth: "hsl(350, 72%, 30%)",
    dark: "#0b0202",
    light: "#fff8f4",
  },
  cool: {
    skin: "hsl(194, 42%, 62%)",
    skinHighlight: "hsl(194, 58%, 76%)",
    skinShadow: "hsl(206, 38%, 42%)",
    accent: "hsl(148, 94%, 52%)",
    mouth: "hsl(204, 55%, 24%)",
    dark: "#050b12",
    light: "#f4fdff",
  },
  sleepy: {
    skin: "hsl(270, 38%, 70%)",
    skinHighlight: "hsl(270, 54%, 84%)",
    skinShadow: "hsl(268, 28%, 52%)",
    accent: "hsl(52, 92%, 70%)",
    mouth: "hsl(272, 42%, 32%)",
    dark: "#090511",
    light: "#fbf7ff",
  },
  surprised: {
    skin: "hsl(58, 92%, 66%)",
    skinHighlight: "hsl(58, 100%, 80%)",
    skinShadow: "hsl(42, 72%, 47%)",
    accent: "hsl(316, 92%, 62%)",
    mouth: "hsl(18, 70%, 32%)",
    dark: "#0b0700",
    light: "#fffde8",
  },
  smirk: {
    skin: "hsl(155, 46%, 62%)",
    skinHighlight: "hsl(155, 60%, 76%)",
    skinShadow: "hsl(160, 34%, 43%)",
    accent: "hsl(286, 82%, 66%)",
    mouth: "hsl(158, 52%, 28%)",
    dark: "#03100b",
    light: "#f3fff9",
  },
};

let scriptsPromise: Promise<void> | null = null;

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }

    const script = existing ?? document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));

    if (!existing) {
      document.body.appendChild(script);
    }
  });
}

function loadAnimationLibraries() {
  if (!scriptsPromise) {
    scriptsPromise = Promise.all([loadScript(ZDOG_SRC), loadScript(GSAP_SRC)]).then(
      () => undefined,
    );
  }

  return scriptsPromise;
}

function mirrorPart(part: ZdogNode, translate: Vector = {}) {
  const copy = part.copyGraph({ translate });
  copy.scale.x = -1;
  return copy;
}

function createEye(
  Zdog: ZdogApi,
  head: ZdogNode,
  variant: CharacterVariant,
  palette: Palette,
  side: -1 | 1,
) {
  const eyeAnchor = new Zdog.Anchor({
    addTo: head,
    translate: { x: side * 56, y: variant === "sleepy" ? -22 : -30, z: 86 },
    rotate: { y: (side * -Zdog.TAU) / 13 },
  });
  const eye = new Zdog.Group({ addTo: eyeAnchor });

  if (variant === "happy") {
    new Zdog.Shape({
      addTo: eye,
      stroke: 13,
      color: palette.dark,
      closed: false,
      path: [
        { x: -23, y: 12 },
        {
          bezier: [
            { x: -12, y: -4 },
            { x: 12, y: -4 },
            { x: 23, y: 12 },
          ],
        },
      ],
    });
    new Zdog.Shape({
      addTo: eye,
      stroke: 8,
      color: palette.light,
      translate: { x: -9, y: 2, z: 3 },
    });
  } else if (variant === "excited") {
    new Zdog.Ellipse({
      addTo: eye,
      width: 54,
      height: 66,
      stroke: 7,
      fill: true,
      color: palette.light,
    });
    new Zdog.Ellipse({
      addTo: eye,
      width: 24,
      height: 34,
      stroke: 0,
      fill: true,
      color: palette.dark,
      translate: { z: 3 },
    });
    new Zdog.Shape({
      addTo: eye,
      stroke: 7,
      color: palette.accent,
      translate: { x: -9, y: -10, z: 6 },
    });
  } else if (variant === "cool") {
    new Zdog.Shape({
      addTo: eye,
      stroke: 9,
      fill: true,
      color: palette.dark,
      path: [
        { x: -34, y: -12 },
        { x: 32, y: -9 },
        { x: 25, y: 21 },
        { x: -25, y: 19 },
      ],
    });
    new Zdog.Shape({
      addTo: eye,
      stroke: 4,
      color: palette.accent,
      closed: false,
      path: [
        { x: -21, y: -2 },
        { x: 20, y: 0 },
      ],
    });
  } else if (variant === "sleepy") {
    new Zdog.Shape({
      addTo: eye,
      stroke: 12,
      color: palette.dark,
      closed: false,
      path: [
        { x: -29, y: 9 },
        {
          bezier: [
            { x: -12, y: 22 },
            { x: 12, y: 22 },
            { x: 29, y: 9 },
          ],
        },
      ],
    });
    new Zdog.Shape({
      addTo: eye,
      stroke: 5,
      color: palette.skinHighlight,
      closed: false,
      translate: { y: -8, z: 3 },
      path: [
        { x: -16, y: 5 },
        { x: 16, y: 5 },
      ],
    });
  } else if (variant === "surprised") {
    new Zdog.Ellipse({
      addTo: eye,
      width: 62,
      height: 72,
      stroke: 6,
      fill: true,
      color: palette.light,
    });
    new Zdog.Ellipse({
      addTo: eye,
      width: 26,
      height: 36,
      stroke: 0,
      fill: true,
      color: palette.dark,
      translate: { z: 4 },
    });
    new Zdog.Shape({
      addTo: eye,
      stroke: 8,
      color: palette.light,
      translate: { x: -11, y: -11, z: 7 },
    });
  } else {
    const lift = side === -1 ? -6 : 4;
    new Zdog.Shape({
      addTo: eye,
      stroke: 12,
      color: palette.dark,
      closed: false,
      rotate: { z: side * -0.08 },
      translate: { y: lift },
      path: [
        { x: -31, y: 5 },
        {
          bezier: [
            { x: -12, y: -7 },
            { x: 12, y: -7 },
            { x: 31, y: 5 },
          ],
        },
      ],
    });
    new Zdog.Shape({
      addTo: eye,
      stroke: 6,
      color: palette.accent,
      translate: { x: -10, y: lift - 2, z: 3 },
    });
  }

  return eye;
}

function createMouth(Zdog: ZdogApi, head: ZdogNode, variant: CharacterVariant, palette: Palette) {
  const mouth = new Zdog.Anchor({
    addTo: head,
    translate: { y: 39, z: 96 },
    rotate: { x: -Zdog.TAU / 48 },
  });

  if (variant === "happy") {
    new Zdog.Shape({
      addTo: mouth,
      stroke: 11,
      color: palette.dark,
      closed: false,
      path: [
        { x: -34, y: 0 },
        {
          bezier: [
            { x: -24, y: 26 },
            { x: 24, y: 26 },
            { x: 34, y: 0 },
          ],
        },
      ],
    });
    new Zdog.Shape({
      addTo: mouth,
      stroke: 5,
      color: palette.light,
      translate: { y: 12, z: 4 },
      path: [{ x: -12 }, { x: 12 }],
    });
  } else if (variant === "excited") {
    new Zdog.Ellipse({
      addTo: mouth,
      width: 76,
      height: 54,
      stroke: 0,
      fill: true,
      color: palette.dark,
    });
    new Zdog.Shape({
      addTo: mouth,
      stroke: 0,
      fill: true,
      color: palette.light,
      translate: { y: -13, z: 4 },
      path: [
        { x: -30, y: 0 },
        { x: 30, y: 0 },
        {
          bezier: [
            { x: 20, y: 15 },
            { x: -20, y: 15 },
            { x: -30, y: 0 },
          ],
        },
      ],
    });
  } else if (variant === "cool") {
    new Zdog.Shape({
      addTo: mouth,
      stroke: 9,
      color: palette.dark,
      closed: false,
      path: [
        { x: -30, y: 10 },
        {
          bezier: [
            { x: -10, y: 18 },
            { x: 12, y: 18 },
            { x: 32, y: 8 },
          ],
        },
      ],
    });
    new Zdog.Shape({
      addTo: mouth,
      stroke: 4,
      color: palette.accent,
      translate: { y: 3, z: 3 },
      path: [{ x: -15 }, { x: 15 }],
    });
  } else if (variant === "sleepy") {
    new Zdog.Shape({
      addTo: mouth,
      stroke: 7,
      color: palette.dark,
      closed: false,
      path: [
        { x: -18, y: 8 },
        {
          bezier: [
            { x: -8, y: 17 },
            { x: 8, y: 17 },
            { x: 18, y: 8 },
          ],
        },
      ],
    });
  } else if (variant === "surprised") {
    new Zdog.Ellipse({
      addTo: mouth,
      width: 44,
      height: 52,
      stroke: 7,
      fill: true,
      color: palette.dark,
    });
    new Zdog.Ellipse({
      addTo: mouth,
      width: 25,
      height: 31,
      stroke: 0,
      fill: true,
      color: palette.mouth,
      translate: { z: 3 },
    });
  } else {
    new Zdog.Shape({
      addTo: mouth,
      stroke: 10,
      color: palette.dark,
      closed: false,
      path: [
        { x: -26, y: 14 },
        {
          bezier: [
            { x: -8, y: 14 },
            { x: 17, y: 3 },
            { x: 36, y: -6 },
          ],
        },
      ],
    });
    new Zdog.Shape({
      addTo: mouth,
      stroke: 5,
      color: palette.skinHighlight,
      translate: { y: -4, z: 4 },
      path: [{ x: 10 }, { x: 29 }],
    });
  }

  return mouth;
}

function createCharacter(illo: ZdogNode, variant: CharacterVariant): CharacterModel {
  const Zdog = window.Zdog;
  if (!Zdog) {
    throw new Error("Zdog is not loaded");
  }

  const palette = PALETTES[variant];
  const root = new Zdog.Anchor({ addTo: illo });
  const body = new Zdog.Anchor({ addTo: root, translate: { y: 70 } });
  const bodyCore = new Zdog.Group({ addTo: body });

  new Zdog.Shape({
    addTo: bodyCore,
    stroke: 72,
    color: palette.skinShadow,
    translate: { x: 4, y: 12, z: -8 },
    path: [{ x: -8 }, { x: 8 }],
  });
  new Zdog.Shape({
    addTo: bodyCore,
    stroke: 64,
    color: palette.skin,
    translate: { y: 8 },
    path: [{ x: -8 }, { x: 8 }],
  });
  new Zdog.Shape({
    addTo: bodyCore,
    stroke: 9,
    color: palette.accent,
    closed: false,
    translate: { y: -20, z: 34 },
    path: [{ x: -24 }, { x: 24 }],
  });

  const arm = new Zdog.Shape({
    addTo: body,
    stroke: 22,
    color: palette.skin,
    closed: false,
    translate: { z: -4 },
    path: [
      { x: -42, y: -16 },
      {
        bezier: [
          { x: -64, y: -5 },
          { x: -58, y: 35 },
          { x: -42, y: 45 },
        ],
      },
    ],
  });
  mirrorPart(arm);

  const leg = new Zdog.Shape({
    addTo: root,
    stroke: 25,
    color: palette.skin,
    closed: false,
    translate: { x: -23, y: 134, z: -7 },
    path: [{ y: 0 }, { y: 40 }],
  });
  new Zdog.Hemisphere({
    addTo: root,
    diameter: 28,
    stroke: 5,
    color: palette.skin,
    backface: palette.skinShadow,
    translate: { x: -24, y: 176, z: 8 },
    rotate: { x: Zdog.TAU / 4 },
  });
  mirrorPart(leg, { x: 23, y: 134, z: -7 });
  new Zdog.Hemisphere({
    addTo: root,
    diameter: 28,
    stroke: 5,
    color: palette.skin,
    backface: palette.skinShadow,
    translate: { x: 24, y: 176, z: 8 },
    rotate: { x: Zdog.TAU / 4 },
  });

  const head = new Zdog.Anchor({ addTo: root, translate: { y: -46 } });
  new Zdog.Shape({
    addTo: head,
    stroke: 196,
    color: palette.skinShadow,
    translate: { x: 4, y: 4, z: -8 },
    path: [{ x: -5 }, { x: 5 }],
  });
  new Zdog.Shape({
    addTo: head,
    stroke: 186,
    color: palette.skin,
    translate: { x: -4 },
    path: [{ x: -5 }, { x: 5 }],
  });
  new Zdog.Shape({
    addTo: head,
    stroke: 28,
    color: palette.accent,
    translate: { x: 0, y: -104, z: 4 },
    path: [{ y: -18 }, { y: -18 }],
  });

  const eyes = [
    createEye(Zdog, head, variant, palette, -1),
    createEye(Zdog, head, variant, palette, 1),
  ];
  const mouth = createMouth(Zdog, head, variant, palette);

  return {
    head,
    body,
    bodyCore,
    mouth,
    eyes,
    idleTempo: variant === "sleepy" ? 1.5 : variant === "excited" ? 0.7 : 1,
    blink: {
      minDelay:
        variant === "sleepy" ? 0.8 : variant === "surprised" ? 8 : variant === "cool" ? 4 : 2,
      maxDelay:
        variant === "sleepy" ? 2.4 : variant === "surprised" ? 16 : variant === "cool" ? 8 : 6,
      duration: variant === "sleepy" ? 0.22 : 0.08,
      closedScale: variant === "surprised" ? 0.08 : 0.03,
    },
  };
}

export interface InteractiveCharacterProps {
  variant?: CharacterVariant;
  className?: string;
}

export function InteractiveCharacter({ variant = "happy", className }: InteractiveCharacterProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>();
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const tweensRef = useRef<GsapTween[]>([]);
  const variantSeed = useMemo(() => CHARACTER_VARIANTS.indexOf(variant) + 1, [variant]);

  useEffect(() => {
    let disposed = false;
    let removeMouseListener: (() => void) | undefined;

    const addTween = (tween: GsapTween) => {
      tweensRef.current.push(tween);
      return tween;
    };

    const addTimer = (timer: ReturnType<typeof setTimeout>) => {
      timersRef.current.push(timer);
      return timer;
    };

    loadAnimationLibraries()
      .then(() => {
        if (
          disposed ||
          !canvasRef.current ||
          !window.Zdog ||
          !window.TweenMax ||
          !window.TweenLite ||
          !window.Sine
        ) {
          return;
        }

        const { Zdog, TweenMax, TweenLite, Sine } = window;
        const illo = new Zdog.Illustration({
          element: canvasRef.current,
          resize: true,
          dragRotate: false,
          rotate: { y: (variantSeed - 3) * 0.03 },
          onResize(this: ZdogNode, width: number, height: number) {
            this.zoom = Math.min(width, height) / SCENE_SIZE;
          },
        });
        const model = createCharacter(illo, variant);
        const breathDuration = variant === "sleepy" ? 1.25 : variant === "excited" ? 0.55 : 0.85;

        addTween(
          TweenMax.to(model.bodyCore.scale, breathDuration, {
            x: 1.05,
            y: 0.94,
            repeat: -1,
            yoyo: true,
            ease: Sine.easeInOut,
          }),
        );
        addTween(
          TweenMax.to(model.mouth.scale, breathDuration, {
            x: variant === "surprised" ? 1.08 : 1.02,
            y: variant === "sleepy" ? 0.72 : 1.18,
            repeat: -1,
            yoyo: true,
            ease: Sine.easeInOut,
          }),
        );
        addTween(
          TweenMax.to(model.body.translate, breathDuration, {
            y: 76,
            repeat: -1,
            yoyo: true,
            ease: Sine.easeInOut,
          }),
        );

        const blink = () => {
          const delay =
            model.blink.minDelay + Math.random() * (model.blink.maxDelay - model.blink.minDelay);
          addTimer(
            setTimeout(() => {
              if (disposed) return;
              addTween(
                TweenMax.to(
                  model.eyes.map((eye) => eye.scale),
                  model.blink.duration,
                  {
                    y: model.blink.closedScale,
                    repeat: 1,
                    yoyo: true,
                    ease: Sine.easeInOut,
                    onComplete: blink,
                  },
                ),
              );
            }, delay * 1000),
          );
        };
        blink();

        let idleActive = true;
        const idleLook = () => {
          if (disposed || !idleActive) return;
          const x = ((Math.random() * 22 - 11) / 360) * Zdog.TAU;
          const y = ((Math.random() * 36 - 18) / 360) * Zdog.TAU;
          const duration = (0.75 + Math.random() * 0.9) * model.idleTempo;
          addTween(TweenLite.to(model.head.rotate, duration, { x, y, ease: Sine.easeInOut }));
          addTween(
            TweenLite.to(model.body.rotate, duration, {
              x: x / 2,
              y: y / 2,
              ease: Sine.easeInOut,
              onComplete: () =>
                addTimer(setTimeout(idleLook, (450 + Math.random() * 1200) * model.idleTempo)),
            }),
          );
        };
        idleLook();

        const followMouse = (event: MouseEvent) => {
          if (!canvasRef.current) return;
          const rect = canvasRef.current.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const dx = (event.clientX - centerX) / Math.max(rect.width, 1);
          const dy = (event.clientY - centerY) / Math.max(rect.height, 1);

          idleActive = false;
          TweenLite.killTweensOf(model.head.rotate);
          TweenLite.killTweensOf(model.body.rotate);

          addTween(
            TweenMax.to(model.head.rotate, 0.45, {
              x: Math.max(-0.28, Math.min(0.28, -dy * 0.55)),
              y: Math.max(-0.36, Math.min(0.36, dx * 0.72)),
              ease: Sine.easeOut,
            }),
          );
          addTween(
            TweenMax.to(model.body.rotate, 0.5, {
              x: Math.max(-0.12, Math.min(0.12, -dy * 0.22)),
              y: Math.max(-0.18, Math.min(0.18, dx * 0.34)),
              ease: Sine.easeOut,
            }),
          );

          timersRef.current.forEach(clearTimeout);
          timersRef.current = [];
          addTimer(
            setTimeout(() => {
              idleActive = true;
              idleLook();
              blink();
            }, 1500),
          );
        };

        document.addEventListener("mousemove", followMouse);
        removeMouseListener = () => document.removeEventListener("mousemove", followMouse);

        const animate = () => {
          if (disposed) return;
          illo.updateRenderGraph?.();
          frameRef.current = requestAnimationFrame(animate);
        };
        animate();
      })
      .catch((error: unknown) => {
        console.error(error);
      });

    return () => {
      disposed = true;
      removeMouseListener?.();
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      tweensRef.current.forEach((tween) => tween.kill());
      tweensRef.current = [];
    };
  }, [variant, variantSeed]);

  return (
    <canvas
      ref={canvasRef}
      aria-label={`${VARIANT_LABELS[variant]} interactive 3D character`}
      className={cn("block h-full min-h-0 w-full", className)}
    />
  );
}

export default InteractiveCharacter;
