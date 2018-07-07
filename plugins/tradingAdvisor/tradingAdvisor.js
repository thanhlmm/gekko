var util = require('../../core/util');
var _ = require('lodash');
var fs = require('fs');
var toml = require('toml');

var config = util.getConfig();
var dirs = util.dirs();
var log = require(dirs.core + 'log');
var CandleBatcher = require(dirs.core + 'candleBatcher');

var moment = require('moment');
var isLeecher = config.market && config.market.type === 'leech';

var Actor = function(done) {
  _.bindAll(this);

  this.done = done;

  this.batcher = new CandleBatcher(config.tradingAdvisor.candleSize);

  this.methodName = config.tradingAdvisor.method;

  this.setupTradingMethod();

  var mode = util.gekkoMode();

  // the stitcher will try to pump in historical data
  // so that the strat can use this data as a "warmup period"
  //
  // the realtime "leech" market won't use the stitcher
  if(mode === 'realtime' && !isLeecher) {
    var Stitcher = require(dirs.tools + 'dataStitcher');
    var stitcher = new Stitcher(this.batcher);
    stitcher.prepareHistoricalData(done);
  } else
    done();
}

Actor.prototype.setupTradingMethod = function() {

  if(!fs.existsSync(dirs.methods + this.methodName + '.js'))
    util.die('Gekko can\'t find the strategy "' + this.methodName + '"');

  log.info('\t', 'Using the strategy: ' + this.methodName);

  var method = require(dirs.methods + this.methodName);

  // bind all trading method specific functions
  // to the Consultant.
  var Consultant = require('./baseTradingMethod');

  _.each(method, function(fn, name) {
    Consultant.prototype[name] = fn;
  });

  if(config[this.methodName]) {
    var tradingSettings = config[this.methodName];
  }

  this.method = new Consultant(tradingSettings);
  this.method
    .on('advice', this.relayAdvice)
    .on(
      'stratWarmupCompleted',
      e => this.deferredEmit('stratWarmupCompleted', e)
    )
    .on(
      'stratUpdate',
      e => this.deferredEmit('stratUpdate', e)
    ).on('notification',
      e => this.deferredEmit('notification', e)
    )

  this.method
    .on('trade', this.processTrade);

  this.batcher
    .on('candle', _candle => {
      const { id, ...candle } = _candle;
      this.deferredEmit('stratCandle', candle);
      this.emitStratCandle(candle);
    });
}

// HANDLERS
// process the 1m candles
Actor.prototype.processCandle = function(candle, done) {
  this.candle = candle;
  const completedBatch = this.batcher.write([candle]);
  if(completedBatch) {
    this.next = done;
  } else {
    done();
    this.next = _.noop;
  }
  this.batcher.flush();
}

// propogate a custom sized candle to the trading method
Actor.prototype.emitStratCandle = function(candle) {
  this.method.tick(candle, this.next);
}

Actor.prototype.processTrade = function(trade) {
  this.method.processTrade(trade);
}

// pass through shutdown handler
Actor.prototype.finish = function(done) {
  this.method.finish(done);
}

// EMITTERS
Actor.prototype.relayAdvice = function(advice) {
  advice.date = this.candle.start.clone().add(1, 'minute');
  this.deferredEmit('advice', advice);
}


module.exports = Actor;
