const transforms = require('./utils/transforms.js');

module.exports = (eleventyConfig) => {
  eleventyConfig.addPassthroughCopy('src/static');

  // Transforms.
  Object.keys(transforms).forEach((transformName) =>
    eleventyConfig.addTransform(transformName, transforms[transformName])
  );

  // Watch for file changes during local development.
  eleventyConfig.setUseGitIgnore(false);

  return {
    dir: {
      input: 'src/',
      output: 'dist',
      includes: '_includes',
      layouts: '_layouts',
    },
    templateFormats: ['html', 'md', 'njk'],
    htmlTemplateEngine: 'njk',
    passthroughFileCopy: true,
  };
};
