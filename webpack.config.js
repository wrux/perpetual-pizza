const isProduction = process.env.NODE_ENV === 'production';

module.exports = {
  mode: isProduction ? 'production' : 'development',
  entry: {
    app: __dirname + '/src/_assets/app.js',
  },
  output: {
    path: __dirname + (isProduction ? '/dist/static' : '/src/static'),
    filename: 'app.bundled.js',
  },
  module: {
    rules: [{ test: /\.js$/, exclude: /node_modules/, loader: 'babel-loader' }],
  },
};
