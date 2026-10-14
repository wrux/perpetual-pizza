import { EFFECTS, type EffectName } from './effects';
import { defaultConfig, type PizzaConfig, type PizzaController } from './pizza';

/** Cycle length that the speed slider shows as 1×. */
const BASE_CYCLE_SECONDS = 7;
const IDLE_MS = 3000;

type Primitive = number | string | boolean;

/* ------------------------------------------------------------------ */
/* Config <-> URL query string                                         */
/* ------------------------------------------------------------------ */

/** Short, readable query keys for each option. Only non-default values are written. */
const query: Array<{
  key: string;
  read(c: PizzaConfig): Primitive;
  parse(raw: string): Partial<PizzaConfig> | null;
  isDefault(c: PizzaConfig): boolean;
}> = [
  {
    key: 'speed',
    read: (c) => round(BASE_CYCLE_SECONDS / c.cycleSeconds, 2),
    parse: (raw) => num(raw, 0.05, 20, (v) => ({ cycleSeconds: BASE_CYCLE_SECONDS / v })),
    isDefault: (c) => c.cycleSeconds === defaultConfig.cycleSeconds,
  },
  {
    key: 'spin',
    read: (c) => round(c.spinTurns, 2),
    parse: (raw) => num(raw, -5, 5, (v) => ({ spinTurns: v })),
    isDefault: (c) => c.spinTurns === defaultConfig.spinTurns,
  },
  {
    key: 'dir',
    read: (c) => (c.direction === -1 ? 'out' : 'in'),
    parse: (raw) => (raw === 'out' ? { direction: -1 } : raw === 'in' ? { direction: 1 } : null),
    isDefault: (c) => c.direction === defaultConfig.direction,
  },
  {
    key: 'angle',
    read: (c) => Math.round(c.elevation),
    parse: (raw) => num(raw, 10, 90, (v) => ({ elevation: v })),
    isDefault: (c) => c.elevation === defaultConfig.elevation,
  },
  {
    key: 'lens',
    read: (c) => Math.round(c.fov),
    parse: (raw) => num(raw, 20, 100, (v) => ({ fov: v })),
    isDefault: (c) => c.fov === defaultConfig.fov,
  },
  {
    key: 'look',
    read: (c) => c.effect,
    parse: (raw) => ((EFFECTS as readonly string[]).includes(raw) ? { effect: raw as EffectName } : null),
    isDefault: (c) => c.effect === defaultConfig.effect,
  },
  {
    key: 'px',
    read: (c) => Math.round(c.pixelSize),
    parse: (raw) => num(raw, 1, 64, (v) => ({ pixelSize: v })),
    isDefault: (c) => c.pixelSize === defaultConfig.pixelSize,
  },
  {
    key: 'shadows',
    read: (c) => (c.shadows ? 'on' : 'off'),
    parse: (raw) => (raw === 'off' ? { shadows: false } : raw === 'on' ? { shadows: true } : null),
    isDefault: (c) => c.shadows === defaultConfig.shadows,
  },
  ...(['pepperoni', 'mushroom', 'basil', 'olive', 'jalapeno', 'ham'] as const).map((t) => ({
    key: t,
    read: (c: PizzaConfig) => c.toppings[t],
    parse: (raw: string) => num(raw, 0, 100, (v) => ({ toppings: { [t]: Math.round(v) } }) as Partial<PizzaConfig>),
    isDefault: (c: PizzaConfig) => c.toppings[t] === defaultConfig.toppings[t],
  })),
  {
    key: 'seed',
    read: (c) => c.seed,
    parse: (raw) => num(raw, 0, 2 ** 31, (v) => ({ seed: Math.round(v) })),
    isDefault: (c) => c.seed === defaultConfig.seed,
  },
];

function num(raw: string, min: number, max: number, make: (v: number) => Partial<PizzaConfig>) {
  const v = Number(raw);
  return Number.isFinite(v) ? make(Math.min(Math.max(v, min), max)) : null;
}

const round = (v: number, places: number) => Number(v.toFixed(places));

/** Options encoded in the current page URL. */
export function optionsFromUrl(): Partial<PizzaConfig> {
  const params = new URLSearchParams(location.search);
  const out: Partial<PizzaConfig> = {};
  for (const q of query) {
    const raw = params.get(q.key);
    if (raw === null) continue;
    const patch = q.parse(raw);
    if (!patch) continue;
    const { toppings, ...rest } = patch;
    Object.assign(out, rest);
    if (toppings) out.toppings = { ...out.toppings, ...toppings } as PizzaConfig['toppings'];
  }
  return out;
}

function urlFor(config: PizzaConfig): string {
  const params = new URLSearchParams();
  for (const q of query) if (!q.isDefault(config)) params.set(q.key, String(q.read(config)));
  const qs = params.toString();
  return location.pathname + (qs ? `?${qs}` : '');
}

/* Safari rate-limits history updates, so coalesce slider drags. */
let urlTimer = 0;
function writeUrl(config: PizzaConfig) {
  clearTimeout(urlTimer);
  urlTimer = window.setTimeout(() => history.replaceState(null, '', urlFor(config)), 200);
}

/* ------------------------------------------------------------------ */
/* Form binding                                                        */
/* ------------------------------------------------------------------ */

function getPath(obj: unknown, path: string): Primitive | undefined {
  return path
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj) as
    | Primitive
    | undefined;
}

function patchFor(path: string, value: Primitive): Partial<PizzaConfig> {
  const [head, ...rest] = path.split('.');
  if (rest.length === 0) return { [head]: value } as Partial<PizzaConfig>;
  return { [head]: { [rest.join('.')]: value } } as Partial<PizzaConfig>;
}

/* Virtual keys that map onto config fields with a nicer scale for humans. */
const virtual: Record<string, { get(c: PizzaConfig): number; set(v: number): Partial<PizzaConfig> }> = {
  speed: {
    get: (c) => BASE_CYCLE_SECONDS / c.cycleSeconds,
    set: (v) => ({ cycleSeconds: BASE_CYCLE_SECONDS / Math.max(v, 0.05) }),
  },
};

const formatters: Record<string, (v: Primitive) => string> = {
  speed: (v) => `${Number(v).toFixed(2)}×`,
  spinTurns: (v) => `${Number(v).toFixed(2)} turns`,
  elevation: (v) => `${v}°`,
  fov: (v) => `${v}°`,
  pixelSize: (v) => `${v}px`,
};

export function initPanel(pizza: PizzaController) {
  const panel = document.getElementById('options');
  const toggle = document.getElementById('toggle-options');
  const toast = document.querySelector<HTMLElement>('[data-toast]');
  if (!panel || !toggle) return;

  const inputs = Array.from(panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]'));
  const outputs = Array.from(panel.querySelectorAll<HTMLOutputElement>('[data-output]'));
  const conditional = Array.from(panel.querySelectorAll<HTMLElement>('[data-show-for]'));

  const readKey = (key: string): Primitive => (virtual[key] ? virtual[key].get(pizza.config) : (getPath(pizza.config, key) ?? ''));

  /** Tell the slider's track how much of it to fill. */
  const paintTrack = (el: HTMLInputElement) => {
    const min = Number(el.min);
    const max = Number(el.max);
    const pct = ((Number(el.value) - min) / (max - min)) * 100;
    el.style.setProperty('--p', `${pct}%`);
  };

  /** Push the controller's config into the form. */
  function sync() {
    for (const el of inputs) {
      const value = readKey(el.dataset.key!);
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(value);
      else if (el instanceof HTMLInputElement && el.type === 'radio') el.checked = el.value === String(value);
      else el.value = String(value);
      if (el instanceof HTMLInputElement && el.type === 'range') paintTrack(el);
    }
    for (const out of outputs) {
      const key = out.dataset.output!;
      const value = readKey(key);
      out.value = formatters[key] ? formatters[key](value) : String(value);
    }
    for (const el of conditional) {
      el.hidden = !el.dataset.showFor!.split(/\s+/).includes(pizza.config.effect);
    }
  }

  function apply(patch: Partial<PizzaConfig>) {
    pizza.update(patch);
    writeUrl(pizza.config);
    sync();
  }

  for (const el of inputs) {
    const onChange = () => {
      const key = el.dataset.key!;
      let value: Primitive;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') value = el.checked;
      else if (el instanceof HTMLInputElement && el.type === 'range') {
        value = Number(el.value);
        paintTrack(el);
      }
      else value = Number.isNaN(Number(el.value)) ? el.value : Number(el.value);

      if (virtual[key]) apply(virtual[key].set(Number(value)));
      else apply(patchFor(key, value));
    };
    el.addEventListener('input', onChange);
    el.addEventListener('change', onChange);
  }

  /* Actions */
  let toastTimer = 0;
  const notify = (message: string) => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 1800);
  };

  const share = async () => {
    const url = location.origin + urlFor(pizza.config);
    try {
      await navigator.clipboard.writeText(url);
      notify('Link copied');
    } catch {
      notify(url);
    }
  };

  document.querySelectorAll('[data-action="share"]').forEach((el) => el.addEventListener('click', share));
  panel.querySelector('[data-action="reset"]')?.addEventListener('click', () => {
    apply({ ...defaultConfig, toppings: { ...defaultConfig.toppings } });
    notify('Back to the house pizza');
  });

  /* Tabs: all focusable, arrows move between them, the dock animates to the new height. */
  const tabButtons = Array.from(panel.querySelectorAll<HTMLButtonElement>('[role="tab"][data-tab]'));
  const panes = Array.from(panel.querySelectorAll<HTMLElement>('[data-pane]'));
  const paneHost = panel.querySelector<HTMLElement>('.dock__panes');
  let heightTimer = 0;
  const selectTab = (id: string, focus = false) => {
    const before = paneHost?.offsetHeight ?? 0;
    for (const b of tabButtons) {
      const on = b.dataset.tab === id;
      b.setAttribute('aria-selected', String(on));
      if (on && focus) b.focus();
    }
    for (const pane of panes) pane.hidden = pane.dataset.pane !== id;
    if (!paneHost || !panel.classList.contains('open')) return;
    // Animate from the old height to the new one, then let it size itself again.
    paneHost.style.height = 'auto';
    const after = paneHost.offsetHeight;
    if (after === before) return;
    paneHost.style.height = `${before}px`;
    void paneHost.offsetHeight;
    paneHost.style.height = `${after}px`;
    clearTimeout(heightTimer);
    heightTimer = window.setTimeout(() => (paneHost.style.height = ''), 300);
  };
  for (const b of tabButtons) {
    b.addEventListener('click', () => selectTab(b.dataset.tab!));
    b.addEventListener('keydown', (event) => {
      const i = tabButtons.indexOf(b);
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      selectTab(tabButtons[(i + step + tabButtons.length) % tabButtons.length].dataset.tab!, true);
    });
  }

  /* Open / close */
  const isOpen = () => panel.classList.contains('open');
  const setOpen = (open: boolean) => {
    panel.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('options-open', open);
    wake();
  };
  toggle.addEventListener('click', () => setOpen(!isOpen()));
  panel.querySelector('[data-action="close"]')?.addEventListener('click', () => setOpen(false));
  // Clicking anywhere on the page outside the panel and toolbar closes it.
  document.addEventListener('pointerdown', (event) => {
    if (!isOpen()) return;
    const t = event.target as Element | null;
    if (t && (panel.contains(t) || t.closest('.toolbar'))) return;
    setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    const t = event.target as HTMLElement | null;
    if (t && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;
    if (event.key === 'o') setOpen(!isOpen());
    if (event.key === 'Escape') setOpen(false);
  });

  /* Swipe the sheet down to dismiss it on phones. */
  const phone = window.matchMedia('(max-width: 640px)');
  const grip = Array.from(panel.querySelectorAll<HTMLElement>('.dock__grip, .dock__header, .dock__tabs'));
  let dragStart: number | null = null;
  let dragY = 0;
  let dragT = 0;
  const onDragMove = (event: PointerEvent) => {
    if (dragStart === null) return;
    dragY = Math.max(0, event.clientY - dragStart);
    panel.style.transform = `translateY(${dragY}px)`;
  };
  const onDragEnd = () => {
    if (dragStart === null) return;
    const fast = dragY / Math.max(performance.now() - dragT, 1) > 0.5;
    dragStart = null;
    panel.classList.remove('dragging');
    panel.style.transform = '';
    if (dragY > 90 || (fast && dragY > 24)) setOpen(false);
    dragY = 0;
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', onDragEnd);
    document.removeEventListener('pointercancel', onDragEnd);
  };
  for (const el of grip) {
    el.addEventListener('pointerdown', (event) => {
      if (!phone.matches || !isOpen() || event.pointerType === 'mouse') return;
      dragStart = event.clientY;
      dragT = performance.now();
      dragY = 0;
      panel.classList.add('dragging');
      document.addEventListener('pointermove', onDragMove);
      document.addEventListener('pointerup', onDragEnd);
      document.addEventListener('pointercancel', onDragEnd);
    });
  }

  /* Real previews for the look tiles and topping icons, rendered once things are idle. */
  const schedule = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 300));
  schedule(async () => {
    const previews = await pizza.renderPreviews(96);
    for (const [effect, url] of Object.entries(previews.looks)) {
      const el = panel.querySelector<HTMLElement>(`[data-look-preview="${effect}"]`);
      if (!el) continue;
      el.style.setProperty('--preview', `url(${url})`);
      el.classList.add('has-preview');
    }
    for (const [kind, url] of Object.entries(previews.toppings)) {
      panel.querySelector<HTMLElement>(`[data-topping-preview="${kind}"]`)?.style.setProperty('--preview', `url(${url})`);
    }
  });

  /* Fade the chrome out when the viewer just wants to watch. */
  let idleTimer = 0;
  function wake() {
    document.body.classList.remove('is-idle');
    clearTimeout(idleTimer);
    if (!isOpen()) idleTimer = window.setTimeout(() => document.body.classList.add('is-idle'), IDLE_MS);
  }
  ['pointermove', 'pointerdown', 'mousemove', 'mousedown', 'click', 'keydown', 'touchstart'].forEach((e) =>
    document.addEventListener(e, wake, { passive: true }),
  );
  wake();

  sync();
  history.replaceState(null, '', urlFor(pizza.config));
}
