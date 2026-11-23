import { defaultConfig, type PizzaConfig, type PizzaController } from './pizza';

/** Cycle length that the speed slider shows as 1×. */
const BASE_CYCLE_SECONDS = 7;
const IDLE_MS = 3000;

type Primitive = number | string | boolean;

/* ------------------------------------------------------------------ */
/* Controls <-> config                                                 */
/* ------------------------------------------------------------------ */

/** Every control names the setting it edits in `data-key`, as a path into the config. */
const controls = () => Array.from(document.querySelectorAll<HTMLInputElement>('[data-key]'));

/* Keys that map onto config fields with a nicer scale for humans. */
const virtual: Record<string, { get(c: PizzaConfig): number; set(v: number): Partial<PizzaConfig> }> = {
  speed: {
    get: (c) => BASE_CYCLE_SECONDS / c.cycleSeconds,
    set: (v) => ({ cycleSeconds: BASE_CYCLE_SECONDS / Math.max(v, 0.05) }),
  },
};

/** The value a key has in a config. */
const read = (config: PizzaConfig, key: string): Primitive =>
  virtual[key]
    ? virtual[key].get(config)
    : (key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], config) as Primitive);

/** The change to a config that gives a key a value. */
function patchFor(key: string, value: Primitive): Partial<PizzaConfig> {
  if (virtual[key]) return virtual[key].set(Number(value));
  const [head, tail] = key.split('.');
  return { [head]: tail ? { [tail]: value } : value } as Partial<PizzaConfig>;
}

const formatters: Record<string, (v: Primitive) => string> = {
  speed: (v) => `${Number(v).toFixed(2)}×`,
  spinTurns: (v) => `${Number(v).toFixed(2)} turns`,
  elevation: (v) => `${v}°`,
  fov: (v) => `${v}°`,
};

/* ------------------------------------------------------------------ */
/* Config <-> URL                                                      */
/* ------------------------------------------------------------------ */

/** A key's name in the URL: the last part of its path, so `toppings.olive` is just `olive`. */
const param = (key: string) => key.split('.').pop()!;

/**
 * Options encoded in the page's URL. Each control accepts what it could have
 * been set to by hand: a slider any number within its range, a choice only one
 * of its values.
 */
export function optionsFromUrl(): Partial<PizzaConfig> {
  const params = new URLSearchParams(location.search);
  const out: Partial<PizzaConfig> = {};
  for (const el of controls()) {
    const key = el.dataset.key!;
    const raw = params.get(param(key));
    const number = Number(raw);
    if (raw === null || (el.type === 'radio' ? raw !== el.value : Number.isNaN(number))) continue;
    const value = el.type === 'radio' ? (Number.isNaN(number) ? raw : number) : Math.min(Math.max(number, Number(el.min)), Number(el.max));
    const { toppings, ...rest } = patchFor(key, value);
    Object.assign(out, rest, toppings && { toppings: { ...out.toppings, ...toppings } });
  }
  return out;
}

/** The page's address with every setting that isn't at its default. */
function urlFor(config: PizzaConfig): string {
  const params = new URLSearchParams();
  for (const key of new Set(controls().map((el) => el.dataset.key!))) {
    const value = read(config, key);
    if (value !== read(defaultConfig, key)) params.set(param(key), String(typeof value === 'number' ? Number(value.toFixed(2)) : value));
  }
  const qs = params.toString();
  return location.pathname + (qs ? `?${qs}` : '');
}

/* Safari rate-limits history updates, so coalesce slider drags. */
let urlTimer = 0;
function writeUrl(config: PizzaConfig) {
  clearTimeout(urlTimer);
  urlTimer = window.setTimeout(() => history.replaceState(null, '', urlFor(config)), 200);
}

/** Wire up the controls. Resolves once the look and topping pictures are drawn. */
export async function initPanel(pizza: PizzaController) {
  const panel = document.getElementById('options');
  const toggle = document.getElementById('toggle-options');
  if (!panel || !toggle) return;

  const inputs = controls();
  const outputs = Array.from(panel.querySelectorAll<HTMLOutputElement>('[data-output]'));

  const readKey = (key: string) => read(pizza.config, key);

  /** Tell the slider's track how much of it to fill. */
  const paintTrack = (el: HTMLInputElement) => {
    const min = Number(el.min);
    const max = Number(el.max);
    const pct = ((Number(el.value) - min) / (max - min)) * 100;
    el.style.setProperty('--p', `${pct}%`);
  };

  const showValue = (out: HTMLOutputElement, value: Primitive) => {
    const key = out.dataset.output!;
    out.value = formatters[key] ? formatters[key](value) : String(value);
    // A topping at zero is off the pizza: its tile fades back.
    out.closest('.topping')?.classList.toggle('is-off', Number(value) === 0);
  };

  /** Push the controller's config into the form. */
  function sync() {
    for (const el of inputs) {
      const value = readKey(el.dataset.key!);
      if (el.type === 'radio') el.checked = el.value === String(value);
      else el.value = String(value);
      if (el.type === 'range') paintTrack(el);
    }
    for (const out of outputs) showValue(out, readKey(out.dataset.output!));
  }

  function apply(patch: Partial<PizzaConfig>) {
    clearTimeout(bakeTimer);
    baking = {};
    pizza.update(patch);
    writeUrl(pizza.config);
    sync();
  }

  /*
   * Changing a topping rebuilds the whole pizza, which is far too slow to do
   * on every step of a drag. The number follows the slider straight away and
   * the pizza is rebuilt once the slider has been still for a moment.
   */
  let baking: Partial<PizzaConfig['toppings']> = {};
  let bakeTimer = 0;
  function bake(topping: keyof PizzaConfig['toppings'], count: number) {
    if ((baking[topping] ?? pizza.config.toppings[topping]) === count) return;
    baking[topping] = count;
    clearTimeout(bakeTimer);
    bakeTimer = window.setTimeout(() => apply({ toppings: { ...pizza.config.toppings, ...baking } }), 160);
  }

  for (const el of inputs) {
    const onChange = () => {
      const key = el.dataset.key!;
      let value: Primitive;
      if (el.type === 'range') {
        value = Number(el.value);
        paintTrack(el);
      } else value = Number.isNaN(Number(el.value)) ? el.value : Number(el.value);

      if (key.startsWith('toppings.')) {
        const out = outputs.find((o) => o.dataset.output === key);
        if (out) showValue(out, value);
        bake(param(key) as keyof PizzaConfig['toppings'], Number(value));
      } else apply(patchFor(key, value));
    };
    el.addEventListener('input', onChange);
    el.addEventListener('change', onChange);
  }

  /* Actions */
  /* Little confirmation bubbles that hang off the button that was pressed. */
  const toastTimers = new Map<string, number>();
  const notify = (which: 'share' | 'reset', message?: string) => {
    const toast = document.querySelector<HTMLElement>(`[data-toast="${which}"]`);
    if (!toast) return;
    const text = toast.querySelector('[data-toast-text]');
    if (text && message) text.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimers.get(which));
    toastTimers.set(which, window.setTimeout(() => toast.classList.remove('show'), 1800));
  };

  const share = async () => {
    const url = location.origin + urlFor(pizza.config);
    try {
      await navigator.clipboard.writeText(url);
      notify('share', 'Link copied');
    } catch {
      notify('share', 'Copy failed');
    }
  };

  document.querySelectorAll('[data-action="share"]').forEach((el) => el.addEventListener('click', share));
  panel.querySelector('[data-action="reset"]')?.addEventListener('click', () => {
    apply({ ...defaultConfig, toppings: { ...defaultConfig.toppings } });
    notify('reset', 'Back to default');
  });

  /* Tabs: all focusable, arrows move between them, the dock animates to the new height. */
  const tabButtons = Array.from(panel.querySelectorAll<HTMLButtonElement>('[role="tab"][data-tab]'));
  const panes = Array.from(panel.querySelectorAll<HTMLElement>('[data-pane]'));
  const paneHost = panel.querySelector<HTMLElement>('form');
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
  const grip = Array.from(panel.querySelectorAll<HTMLElement>('header'));
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

  /* Pictures for the looks and the toppings, drawn from the real pizza. */
  const previews = await pizza.renderPreviews(96);
  for (const [effect, url] of Object.entries(previews.looks)) {
    document.querySelector<HTMLElement>(`[data-look-preview="${effect}"]`)?.style.setProperty('--preview', `url(${url})`);
  }
  for (const [kind, url] of Object.entries(previews.toppings)) {
    panel.querySelector<HTMLElement>(`[data-topping-preview="${kind}"]`)?.style.setProperty('--preview', `url(${url})`);
  }
}
