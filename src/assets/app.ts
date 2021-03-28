import { LitElement, html, customElement, property, css } from 'lit-element';

@customElement('pizza-counter')
class PizzaCounter extends LitElement {
	@property()
	count = 0;

	connectedCallback() {
		super.connectedCallback()
		setInterval(() => ++this.count, 3000);
	}

	render() {
		return html`<div>
			<h1>Pizza Watched</h1>
			<p>${this.count}</p>
		</div>`;
	}

	static get styles() {
		return css`
      div {
        color: white;
        text-align: center;
        padding: 1rem;
        text-shadow: 6px 6px 0 rgba(0,0,0, 0.25);
			}
			
			h1 {
        margin: 0;
        line-height: 45px;
        font-size: 25px;
        font-weight: bold;
        color: white;
        text-transform: uppercase;
        letter-spacing: 5px;
			}
			
			p {
        margin: 0;
        line-height: 72px;
        font-size: 64px;
        font-weight: bold;
        color: white;
        font-family: monospace;
			}
    `;
	}
}