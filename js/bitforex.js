'use strict';

// ---------------------------------------------------------------------------

const Exchange = require ('./base/Exchange');
const { ExchangeError } = require ('./base/errors');

// ---------------------------------------------------------------------------

module.exports = class bitforex extends Exchange {
    describe () {
        return this.deepExtend (super.describe (), {
            'id': 'bitforex',
            'name': 'bitforex',
            'countries': [ 'CN', 'US' ],
            'version': 'v1',
            'has': {
                'CORS': false,
                'fetchOHLCV': false,
                'fetchTrades': false,
                'fetchOpenOrders': false,
                'fetchClosedOrders': false,
                'fetchOrder': true,
                'fetchOrders': false,
            },
            'urls': {
                'api': {
                    'public': 'https://api.bitforex.com',
                    'private': 'https://api.bitforex.com',
                },
                'www': 'https://www.bitforex.com',
                'doc': 'https://github.com/bitforexapi/API_Doc_en/wiki',
                'fees': 'https://support.bitforex.com/hc/en-us/articles/360006824872-Trading-Fees',
            },
            'requiredCredentials': {
                'apiKey': true,
                'secret': true,
            },
            'fees': {
                'trading': {
                    'taker': 0.0005,
                    'maker': 0.0,
                },
            },
            'api': {
                'public': {
                    'get': [
                        'market/symbols',
                        'market/ticker',
                        'market/trades',
                        'market/depth',
                        'market/kline',
                    ],
                },
                'private': {
                    'post': [
                        'fund/allAccount',
                        'fund/mainAccount',
                        'trade/placeOrder',
                        'trade/cancelOrder',
                        'trade/cancelAllOrder',
                        'trade/orderInfo',
                        'trade/placeMultiOrder',
                        'trade/cancelMultiOrder',
                        'trade/multiOrderInfo',
                    ],
                },
            },
        });
    }

    async fetchMarkets () {
        let markets = await this.publicGetMarketSymbols ();
        markets = this.safeValue (markets, 'data');
        let result = [];
        for (let i = 0; i < markets.length; i++) {
            let id = markets[i]['symbol'];
            let [ quoteId, baseId ] = id.split ('-').slice (1, 3);
            let baseIdUppercase = baseId.toUpperCase ();
            let quoteIdUppercase = quoteId.toUpperCase ();
            let base = this.commonCurrencyCode (baseIdUppercase);
            let quote = this.commonCurrencyCode (quoteIdUppercase);
            let symbol = base + '/' + quote;
            let market = {
                'id': id,
                'symbol': symbol,
                'base': base,
                'quote': quote,
                'precision': {
                    'price': markets[i]['pricePrecision'],
                    'amount': markets[i]['amountPrecision'],
                },
                'limits': {
                    'amount': {
                        'min': markets[i]['minOrderAmount'],
                    },
                },
                'info': markets[i],
            };
            result.push (market);
        }
        return result;
    }

    parseTicker (ticker, market = undefined) {
        let symbol = undefined;
        if (market)
            symbol = market['symbol'];
        let timestamp = this.safeInteger (ticker, 'date');
        return {
            'symbol': symbol,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'ask': this.safeFloat (ticker, 'sell'),
            'bid': this.safeFloat (ticker, 'buy'),
            'high': this.safeFloat (ticker, 'high'),
            'low': this.safeFloat (ticker, 'low'),
            'last': this.safeFloat (ticker, 'last'),
            'volume': this.safeFloat (ticker, 'vol'),
            'info': ticker,
        };
    }

    async fetchTicker (symbol, params = {}) {
        await this.loadMarkets ();
        let market = this.market (symbol);
        let ticker = await this.publicGetMarketTicker (this.extend ({
            'symbol': this.marketId (symbol),
        }, params));
        ticker = ticker['data'];
        return this.parseTicker (ticker, market);
    }

    async createOrder (symbol, type, side, amount, price = undefined, params = {}) {
        await this.loadMarkets ();
        // type is ignored
        // setting price beyond offer seems like the only way to issue a taker order
        let order = {
            'symbol': this.marketId (symbol),
            'amount': amount,
            'price': price,
            'tradeType': (side === 'sell') ? 2 : 1,
        };
        let result = await this.privatePostTradePlaceOrder (this.extend (order, params));
        return {
            'info': result,
            'id': result['data']['orderId'],
        };
    }

    async cancelOrder (id, symbol = undefined, params = {}) {
        if (typeof symbol === 'undefined')
            throw new ExchangeError (this.id + ' cancelOrder() requires a symbol argument');
        await this.loadMarkets ();
        let marketId = this.marketId (symbol);
        let request = this.extend ({ 'orderId': id, 'symbol': marketId }, params);
        let result = await this.privatePostTradeCancelOrder (request);
        return result;
    }

    parseOrderStatus (status) {
        if (status === 0) {
            // Not Closed
            return 'open';
        } else if (status === 1) {
            // Part Transaction
            return 'open';
        } else if (status === 2) {
            // All Transaction
            return 'closed';
        } else if (status === 3) {
            // 3 Partial Deal Canceled
            return 'open';
        } else if (status === 4) {
            // All Revoked
            return 'canceled';
        }
        return status;
    }

    parseOrder (order, market = undefined) {
        let status = this.parseOrderStatus (order['orderState']);
        let symbol = undefined;
        if (typeof market === 'undefined') {
            if ('symbol' in order)
                if (order['symbol'] in this.markets_by_id)
                    market = this.markets_by_id[order['symbol']];
        }
        if (market)
            symbol = market['symbol'];
        let timestamp = order['createTime'];
        let price = this.safeFloat (order, 'orderPrice');
        let averagePrice = this.safeFloat (order, 'avgPrice');
        let amount = this.safeFloat (order, 'orderAmount');
        let filled = this.safeFloat (order, 'dealAmount');
        let fee = this.safeFloat (order, 'tradeFee');
        let cost = filled * price;
        let type = (order['tradeType'] === 2) ? 'sell' : 'buy';
        let result = {
            'info': order,
            'id': order['orderId'],
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'symbol': symbol,
            'status': status,
            'price': price,
            'amount': amount,
            'cost': cost,
            'filled': filled,
            'average': averagePrice,
            'type': type,
            'fee': fee,
        };
        return result;
    }

    async fetchOrder (id, symbol = undefined, params = {}) {
        if (typeof symbol === 'undefined')
            throw new ExchangeError (this.id + ' fetchOrder requires a symbol parameter');
        await this.loadMarkets ();
        let marketId = this.marketId (symbol);
        let request = this.extend ({ 'orderId': id, 'symbol': marketId }, params);
        let result = await this.privatePostTradeOrderInfo (request);
        return this.parseOrder (result['data']);
    }

    sign (path, api = 'public', method = 'GET', params = {}, headers = undefined, body = undefined) {
        let url = '/api/';
        url += this.version + '/';
        url += path;
        if (api === 'private') {
            this.checkRequiredCredentials ();
            let nonce = this.milliseconds ().toString ();
            let query = this.keysort (this.extend ({
                'accessKey': this.apiKey,
                'nonce': nonce,
            }, params));
            let queryString = this.rawencode (query);
            url += '?' + queryString;
            query['signData'] = this.hmac (this.encode (url), this.encode (this.secret));
            url += '&signData=' + query['signData'];
        } else {
            if (Object.keys (params).length)
                url += '?' + this.urlencode (params);
        }
        url = this.urls['api'][api] + url;
        return { 'url': url, 'method': method, 'body': body, 'headers': headers };
    }
};
