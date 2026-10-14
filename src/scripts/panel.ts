import { defaultConfig, type PizzaConfig, type PizzaController } from './pizza';

const STORAGE_KEY = 'perpetual-pizza:options';
/** Cycle length that the speed slider shows as 1×. */
const BASE_CYCLE_SECONDS = 7;

type Primitive = number | string | boolean;

/* Read / write dotted paths like "toppings.pepperoni" on a config object. */
function getPath(obj: unknown, path: string): Primitive | undefined {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj) as
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

export function loadSavedOptions(): Partial<PizzaConfig> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<PizzaConfig>) : {};
  } catch {
    return {};
  }
}

function save(config: PizzaConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* private mode or storage blocked: options just won't persist */
  }
}

export function initPanel(pizza: PizzaController) {
  const panel = document.getElementById('options');
  const toggle = document.getElementById('toggle-options');
  if (!panel || !toggle) return;

  const inputs = Array.from(panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]'));
  const outputs = Array.from(panel.querySelectorAll<HTMLOutputElement>('[data-output]'));
  const conditional = Array.from(panel.querySelectorAll<HTMLElement>('[data-show-for]'));

  const readKey = (key: string): Primitive => (virtual[key] ? virtual[key].get(pizza.config) : (getPath(pizza.config, key) ?? ''));

  /** Push the controller's config into the form. */
  function sync() {
    for (const el of inputs) {
      const key = el.dataset.key!;
      const value = readKey(key);
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(value);
      else el.value = String(value);
    }
    for (const out of outputs) {
      const key = out.dataset.output!;
      const value = readKey(key);
      out.value = formatters[key] ? formatters[key](value) : String(value);
    }
    for (const el of conditional) {
      const effects = el.dataset.showFor!.split(/\s+/);
      el.hidden = !effects.includes(pizza.config.effect);
    }
  }

  function apply(patch: Partial<PizzaConfig>) {
    pizza.update(patch);
    save(pizza.config);
    sync();
  }

  for (const el of inputs) {
    const onChange = () => {
      const key = el.dataset.key!;
      let value: Primitive;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') value = el.checked;
      else if (el instanceof HTMLInputElement && el.type === 'range') value = Number(el.value);
      else value = Number.isNaN(Number(el.value)) ? el.value : Number(el.value);

      if (virtual[key]) apply(virtual[key].set(Number(value)));
      else apply(patchFor(key, value));
    };
    el.addEventListener('input', onChange);
    el.addEventListener('change', onChange);
  }

  panel.querySelector('[data-action="shuffle"]')?.addEventListener('click', () => {
    apply({ seed: Math.floor(Math.random() * 1_000_000) });
  });

  panel.querySelector('[data-action="reset"]')?.addEventListener('click', () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    pizza.update({ ...defaultConfig, toppings: { ...defaultConfig.toppings } });
    sync();
  });

  /* Open / close */
  const setOpen = (open: boolean) => {
    panel.hidden = false; // keep it in the layout so the slide transition runs
    panel.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(!panel.classList.contains('open')));
  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.key === 'o') setOpen(!panel.classList.contains('open'));
    if (event.key === 'Escape') setOpen(false);
  });

  sync();
}
