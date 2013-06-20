'use strict';

/**
 * Third party modules.
 */
var Expirable = require('expirable')
  , Routable = require('routable');

/**
 * Node.js build-in modules
 */
var url = require('url')
  , path = require('path');

/**
 * Attach the pagelets to a HTTP server, by doing so, it will return
 * a middleware that can be used to handle the connections to the server.
 *
 * Options:
 *
 * - engine: A pre-configured Engine instance that is mounted to the server.
 * - pages: either a path or an array with Page constructors.
 *
 * @param {HTTP.Server} server
 * @param {Object} options
 * @returns {Function} middlware
 */
exports.attach = function attach(server, options) {
  options = options || {};

  var instances = new Expirable('5 minutes')
    , routes = new Expirable('5 minutes')
    , NotFound = options['404']
    , pages = options.pages;

  // Setup the real-time server
  var Engine = options.engine || exports.Engine
    , engine = new Engine(server, { pages: instances });

  // Process the pages, so we are sure that we got Page based constructors.
  if (!('pages' in options)) {
    throw new Error('Missing `pages` property in the options');
  }

  if (!Array.isArray(pages)) {
    pages = require('fs').readdirSync(pages).map(function resolve(file) {
      return path.resolve(pages, file);
    });
  }

  pages = pages.map(function map(page) {
    // Allow the use of strings, so people can load Pages from different
    // directories instead of putting everything in one single directory.
    if (typeof page === 'string') {
      page = require(page);
    }

    if (typeof page !== 'function') {
      throw new Error('Invalid page type: ' + typeof page);
    }

    if (page instanceof exports.Page) {
      throw new Error('The supplied Page ('+ page.path +') is already initialized');
    }

    // Setup the router, if needed
    if (!page.router) {
      page.router = new Routable(page.prototype.path);
    }

    return page;
  });

  // @TODO Maybe use a resource pool where we have our initialized pages so they
  // can be-reused again, and lowering the garbage collection hit.
  return function middlware(req, res, next) {
    var uri = url.parse(req.url)
      , id = req.method +'@'+ uri.pathname
      , session = req.sessionID
      , cached = routes.get(id)
      , page;

    /**
     * Handle page errors.
     *
     * @param {HTTP.Request} req
     * @param {HTTP.Response} res
     * @param {Error} err
     */
    function fivehundered(req, res, err) {
      res.statusCode = 500;
      res.end(err.message);
    }

    /**
     * Handle page not found calls.
     *
     * @param {HTTP.Request} req
     * @param {HTTP.Response} res
     */
    function fourohfour(req, res) {
      res.statusCode = 404;

      if (NotFound) {
        page = new NotFound({ req: req, res: res, params: {} });
        page.on('error', fivehundered.bind(fivehundered, req, res));
      } else {
        res.end('404, Not found');
      }
    }

    // Fast case, we have already seen and parsed this route in the last
    // 5 minutes, so we don't need to search for it and can execute it right
    // away.
    if (cached) {
      page = new cached.Page({ req: req, res: res, params: cached.params });
      page.on('error', fivehundered.bind(fivehundered, req, res));
      return instances.set(session +':'+ id, page);
    }

    // No matches in the cache, search list of pages for a match
    cached = pages.filter(function filter(page) {
      return page.prototype.method.toLowerCase() === req.method.toLowerCase()
        && page.router.test(uri);
    });

    // We didn't get any matches, forward it to the next middleware layer.
    if (!cached.length) return next();

    cached = { Page: cached.shift() };
    cached.params = cached.Page.router.exec(uri);

    // Cache the route so we don't have to do any more look ups and regexp
    // executions for a while. If it's a hot route it will stay in the cache
    // anyways.
    routes.set(id, cached);

    page = new cached.Page({ req: req, res: res, params: cached.params });
    page.on('error', fivehundered.bind(fivehundered, req, res));
    return instances.set(session +':'+ id, page);
  };
};

/**
 * Expose the real-time Engine.
 */
exports.Engine = require('./engine');

/**
 * Expose the page constructor.
 */
exports.Page = require('./page');

/**
 * Expose the Pagelet constructor.
 */
exports.Pagelet = require('./pagelet');

/**
 * Expose the Store constructor.
 */
exports.Store = require('./store');

/**
 * Expose the current version.
 */
exports.version = require('../package.json').version;
