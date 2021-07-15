module.exports = {
  env: process.env.ELEVENTY_ENV === 'production',
  title: 'Perpetual Pizza',
  description:
    'Watch the never ending digital pizza spin hypnotize you into ordering a pizza.',
  url: 'https://perpetual.pizza',
  author: 'Callum Bonnyman',
  meta_data: {
    twitter: '@wrux',
    default_social_image: '/static/default_social_image.jpg',
  },
  pizzas: {
    cheese: { link: '#', name: 'Cheese' },
    pineapple: { link: '#', name: 'Pineapple' },
    pepperoni: { link: '#', name: 'Pepperoni' },
    mushroom: { link: '#', name: 'Mushroom' },
  },
};
