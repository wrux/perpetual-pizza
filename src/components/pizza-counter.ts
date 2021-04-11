import { LitElement, html, customElement, property, css } from 'lit-element';

/**
 * Pizza counter web component.
 */
@customElement('pizza-counter')
class PizzaCounter extends LitElement {
	@property()
	count = 0;

	connectedCallback() {
		super.connectedCallback()
		setInterval(() => {
			++this.count;
			if (this.count % 20 === 0) {
				plausible('Pizza views', Math.floor(this.count / 20));
			}
		}, 3000);
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
        display: flex;
        flex-direction: column;
        align-items: center;
        color: white;
        text-align: center;
        padding: 1rem;
			}
			
			h1 {
        display: inline-block;
        padding: 0.2em 0.6em;
        border-radius: 0.4rem;
				margin-bottom: 0.2em;
        color: white;
        font-size: clamp(1.333rem, 5vw, 2em);
        font-weight: bold;
        text-transform: uppercase;
        letter-spacing: 0.2em;
        background-color: var(--primary);
        line-height: 1.2;
			}
			
			p {
        padding: 0.1em 0.3em;
        border-radius: 0.4rem;
        margin: 0;
        line-height: 1;
        font-size: clamp(2rem, 10vw, 4rem);
        font-weight: bold;
        color: white;
        font-family: monospace;
				background-color: #E85D04;
			}
    `;
	}
}