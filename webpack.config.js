const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');
const WebpackObfuscator = require('webpack-obfuscator');
const webpack = require('webpack');

const isProd = process.env.NODE_ENV === 'production';
const includeTools = process.env.INCLUDE_TOOLS === '1' || !isProd;

module.exports = {
  mode: isProd ? 'production' : 'development',
  target: ['web', 'es5'],
  entry: {
    app: path.resolve(__dirname, 'public', 'app.entry.js'),
  },
  output: {
    path: path.resolve(__dirname, 'dist', 'public'),
    filename: isProd ? '[name].[contenthash].js' : '[name].js',
    assetModuleFilename: 'assets/[name][ext]'
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
      {
        test: /\.(png|jpe?g|gif|svg|ico)$/i,
        type: 'asset/resource',
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: path.resolve(__dirname, 'public', 'index.template.html'),
      templateParameters: { includeTools },
      minify: {
        removeComments: true,
        collapseWhitespace: true,
        keepClosingSlash: true,
        removeRedundantAttributes: true,
        removeEmptyAttributes: true,
      },
    }),
    new webpack.DefinePlugin({
      __INCLUDE_TOOLS__: JSON.stringify(includeTools),
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || (isProd ? 'production' : 'development')),
    }),
    new MiniCssExtractPlugin({ filename: isProd ? '[name].[contenthash].css' : '[name].css' }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, 'public'),
          to: '.',
          globOptions: { ignore: ['**/index.html', '**/index.template.html', '**/app.js', '**/app.entry.js', '**/styles.css', '**/js/**/*.js'] },
          noErrorOnMissing: true,
        },
      ],
    }),
    ...(isProd
      ? [
          new WebpackObfuscator(
            {
              compact: true,
              rotateStringArray: true,
              stringArray: true,
              stringArrayThreshold: 0.75,
              deadCodeInjection: false,
              controlFlowFlattening: false,
              disableConsoleOutput: true,
            },
            []
          ),
        ]
      : []),
  ],
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        extractComments: false,
        terserOptions: {
          compress: {
            drop_console: true,
            passes: 2,
          },
          mangle: true,
          format: { comments: false },
        },
      }),
      new CssMinimizerPlugin(),
    ],
  },
  devtool: false,
  performance: { hints: false },
};
