# 🍕 Website for perpetual.pizza 🍕

Simple static site for [perpetual.pizza](https://perpetual.pizza) built with
AstroJS. The never ending pizza is rendered live with three.js: a pizza whose
centre is a smaller pizza, zooming in forever.

Feel free to fork this project or take code as you please.

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |

## 🚀 Project Structure

Inside of this project, you'll see the following folders and files:

```
/
├── public/
│   └── favicon.ico
├── src/
│   ├── components/
│   │   └── Pizza.astro      # the canvas + script hook
│   ├── layouts/
│   │   └── Layout.astro
│   ├── pages/
│   │   └── index.astro
│   └── scripts/
│       └── pizza.ts         # three.js scene, config and controller
└── package.json
```
