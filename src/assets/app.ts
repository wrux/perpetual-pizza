import { LitElement, html, customElement, property, css } from 'lit-element';

@customElement('pizza-counter')
class PizzaCounter extends LitElement {
  @property()
  count = 0;

  connectedCallback() {
    super.connectedCallback();
    setInterval(() => {
      ++this.count;
      if (this.count % 20 === 0) {
        plausible('Pizza views', Math.floor(this.count / 20));
      }
    }, 3000);
  }

  render() {
    return html`<p class="${this.count > 0 ? 'show' : ''}">
      🍕 Count <span>${this.count}</span>
    </p>`;
  }

  static get styles() {
    return css`
      p {
        color: white;
        text-align: center;
        padding: 0.33em 1em;
        margin: 0;
        background-color: rgba(255, 255, 255, 0.5);
        backdrop-filter: blur(8px);
        color: rgb(var(--primary));
        font-size: clamp(1.2rem, 5vw, 1.6rem);
        font-weight: bold;
        line-height: 1.2;
        transition: transform 100ms ease-out;
        transform: translateY(-100%);
      }

      p.show {
        transform: translateY(0%);
      }

      span {
        margin-left: 0.1em;
      }
    `;
  }
}
