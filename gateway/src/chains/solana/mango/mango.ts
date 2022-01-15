import {
  Config,
  getAllMarkets,
  getMarketByBaseSymbolAndKind,
  //getMarketByPublicKey,
  getMultipleAccounts,
  //getTokenBySymbol,
  GroupConfig,
  //makeCancelPerpOrderInstruction,
  //makeCancelSpotOrderInstruction,
  //makeSettleFundsInstruction,
  MangoAccount,
  MangoClient,
  MangoGroup,
  MarketConfig,
  PerpMarket,
  PerpMarketLayout,
  //QUOTE_INDEX,
  TokenInfo,
} from '@blockworks-foundation/mango-client';
import {
  Market,
  //Orderbook
} from '@project-serum/serum';
//import { Order } from "@project-serum/serum/lib/market";
import {
  //Account,
  AccountInfo,
  PublicKey,
  //Transaction,
  //TransactionSignature
} from '@solana/web3.js';
//import BN from "bn.js";
import { logger } from '../../../services/logger';
import { zipDict } from '../../../services/base';
import { Solana } from '../solana';
import { MangoConfig } from './mango.config';
import {
  InitializationError,
  SERVICE_UNITIALIZED_ERROR_CODE,
  SERVICE_UNITIALIZED_ERROR_MESSAGE,
} from '../../../services/error-handler';

class Mango {
  private static _instance: Mango;
  private solana: Solana = Solana.getInstance();
  private client: MangoClient;
  public mangoGroupConfig: GroupConfig;
  private _mangoGroup: MangoGroup | undefined;
  private tokenList: Record<string, TokenInfo> = {};
  private _ready: boolean = false;

  constructor() {
    this.mangoGroupConfig = Config.ids().groups.filter(
      (group) => group.name === MangoConfig.config.groupName
    )[0];

    this.client = new MangoClient(
      this.solana.connection,
      this.mangoGroupConfig.mangoProgramId
    );
  }

  /// initialization

  public static getInstance(): Mango {
    if (!Mango._instance) {
      Mango._instance = new Mango();
    }

    return Mango._instance;
  }

  public async init() {
    if (!Solana.getInstance().ready())
      throw new InitializationError(
        SERVICE_UNITIALIZED_ERROR_MESSAGE('SOL'),
        SERVICE_UNITIALIZED_ERROR_CODE
      );

    logger.info(`- fetching mango group`);
    this._mangoGroup = await this.client.getMangoGroup(
      this.mangoGroupConfig.publicKey
    );

    for (const token of this._mangoGroup.tokens) {
      this.tokenList[token.mint.toBase58()] = token;
    }

    logger.info(`- loading root banks`);
    await this._mangoGroup.loadRootBanks(this.solana.connection);

    logger.info(`- loading cache`);
    await this._mangoGroup.loadCache(this.solana.connection);

    this._ready = true;
  }

  public ready(): boolean {
    return this._ready;
  }

  private mangoGroup(): MangoGroup {
    if (!this._mangoGroup)
      throw new InitializationError(
        SERVICE_UNITIALIZED_ERROR_MESSAGE('MANGO'),
        SERVICE_UNITIALIZED_ERROR_CODE
      );
    return <MangoGroup>this._mangoGroup;
  }

  public getTokenByAddress(address: string): TokenInfo {
    return this.tokenList[address];
  }

  public async fetchMangoAccounts(address: PublicKey): Promise<MangoAccount[]> {
    try {
      return await this.client.getMangoAccountsForOwner(
        this.mangoGroup(),
        address
      );
    } catch (error) {
      throw new Error(
        `Error retrieving mango accounts for ${address.toBase58()}`
      );
    }
  }

  private getMarketConfigByName(marketName: string): MarketConfig {
    const s = marketName.split('-');
    if (s[1] == 'PERP') {
      return getMarketByBaseSymbolAndKind(this.mangoGroupConfig, s[0], 'perp');
    } else {
      return getMarketByBaseSymbolAndKind(this.mangoGroupConfig, s[0], 'spot');
    }
  }

  public async fetchMarket(marketName: string): Promise<Market | PerpMarket> {
    const marketConfig = this.getMarketConfigByName(marketName);
    const marketAccountInfo = await this.solana.connection.getAccountInfo(
      marketConfig.publicKey
    );
    if (marketAccountInfo && marketConfig)
      return this.configToMarket(marketConfig, marketAccountInfo);
    else
      throw new Error(
        `Error retrieving AccountInfo for Mango market ${marketName}`
      );
  }

  public async fetchAllMarkets(): Promise<
    Partial<Record<string, Market | PerpMarket>>
  > {
    const allMarketConfigs = getAllMarkets(this.mangoGroupConfig);
    const allMarketPks = allMarketConfigs.map((m) => m.publicKey);
    const allMarketAccountInfos = await getMultipleAccounts(
      this.solana.connection,
      allMarketPks
    );
    const allMarketAccounts = allMarketConfigs.map(
      (config: MarketConfig, i: number) => {
        return this.configToMarket(
          config,
          allMarketAccountInfos[i].accountInfo
        );
      }
    );
    return zipDict(
      allMarketPks.map((pk) => pk.toBase58()),
      allMarketAccounts
    );
  }

  private configToMarket(
    config: MarketConfig,
    marketAccountInfo: AccountInfo<Buffer>
  ): Market | PerpMarket {
    if (config.kind === 'spot') {
      const decoded = Market.getLayout(
        this.mangoGroupConfig.mangoProgramId
      ).decode(marketAccountInfo.data);
      return new Market(
        decoded,
        config.baseDecimals,
        config.quoteDecimals,
        undefined,
        this.mangoGroupConfig.serumProgramId
      );
    }
    if (config.kind === 'perp') {
      const decoded = PerpMarketLayout.decode(marketAccountInfo.data);
      return new PerpMarket(
        config.publicKey,
        config.baseDecimals,
        config.quoteDecimals,
        decoded
      );
    }
    throw new RangeError(`Invalid MarketConfig.kind: ${config.kind}`);
  }

  /**
  public async fetchAllBidsAndAsks(
    mangoAccount: MangoAccount,
    marketName?: string
  ): Promise<OrderBook[]> {
    await mangoAccount.loadOpenOrders(
      this.solana.connection,
      new PublicKey(this.mangoGroupConfig.serumProgramId)
    );
    let allMarketConfigs = getAllMarkets(this.mangoGroupConfig);
    let allMarketPks = allMarketConfigs.map((m) => m.publicKey);

    if (marketName !== undefined) {
      allMarketConfigs = allMarketConfigs.filter(
        (marketConfig) => marketConfig.name === marketName
      );
      allMarketPks = allMarketConfigs.map((m) => m.publicKey);
    }

    const allBidsAndAsksPks = allMarketConfigs
      .map((m) => [m.bidsKey, m.asksKey])
      .flat();
    const allBidsAndAsksAccountInfos = await getMultipleAccounts(
      this.solana.connection,
      allBidsAndAsksPks
    );

    const accountInfos: { [key: string]: AccountInfo<Buffer> } = {};
    allBidsAndAsksAccountInfos.forEach(
      ({ publicKey, context, accountInfo }) => {
        accountInfos[publicKey.toBase58()] = accountInfo;
      }
    );

    const markets = await this.fetchAllMarkets();

    return Object.entries(markets).map(([address, market]) => {
      const marketConfig = getMarketByPublicKey(this.mangoGroupConfig, address);
      if (market instanceof Market) {
        return this.parseSpotOrders(
          market,
          marketConfig,
          accountInfos
        );
      } else if (market instanceof PerpMarket) {
        return this.parsePerpOpenOrders(
          market,
          marketConfig,
          accountInfos
        );
      }
    });
  }

  public getSpotOpenOrdersAccount(
    marketConfig: MarketConfig,
    mangoAccount: MangoAccount
  ): PublicKey | null {
    const spotOpenOrdersAccount = mangoAccount.spotOpenOrdersAccounts[marketConfig.marketIndex];
    return spotOpenOrdersAccount ? spotOpenOrdersAccount.publicKey : null;
  }

  public async fetchAllSpotFills(): Promise<any[]> {
    const allMarketConfigs = getAllMarkets(this.mangoGroupConfig);
    const allMarkets = await this.fetchAllMarkets();

    // merge
    // 1. latest fills from on-chain
    let allRecentMangoAccountSpotFills: any[] = [];
    // 2. historic from off-chain REST service
    let allButRecentMangoAccountSpotFills: any[] = [];

    for (const config of allMarketConfigs) {
      if (config.kind === "spot") {
        const openOrdersAccount =
          mangoAccount.spotOpenOrdersAccounts[config.marketIndex];
        if (openOrdersAccount === undefined) {
          continue;
        }
        const response = await fetch(
          `https://event-history-api.herokuapp.com/trades/open_orders/${openOrdersAccount.publicKey.toBase58()}`
        );
        const responseJson = await response.json();
        allButRecentMangoAccountSpotFills =
          allButRecentMangoAccountSpotFills.concat(
            responseJson?.data ? responseJson.data : []
          );

        const recentMangoAccountSpotFills: any[] = await allMarkets[
          config.publicKey.toBase58()
        ]
          .loadFills(this.solana.connection, 10000)
          .then((fills) => {
            fills = fills.filter((fill) => {
              return openOrdersAccount?.publicKey
                ? fill.openOrders.equals(openOrdersAccount?.publicKey)
                : false;
            });
            return fills.map((fill) => ({ ...fill, marketName: config.name }));
          });
        allRecentMangoAccountSpotFills = allRecentMangoAccountSpotFills.concat(
          recentMangoAccountSpotFills
        );
      }
    }

    const newMangoAccountSpotFills = allRecentMangoAccountSpotFills.filter(
      (fill: any) =>
        !allButRecentMangoAccountSpotFills.flat().find((t: any) => {
          if (t.orderId) {
            return t.orderId === fill.orderId?.toString();
          } else {
            return t.seqNum === fill.seqNum?.toString();
          }
        })
    );

    return [...newMangoAccountSpotFills, ...allButRecentMangoAccountSpotFills];
  }

  public async fetchAllPerpFills(mangoAccount: MangoAccount): Promise<any[]> {
    const allMarkets = await this.fetchAllMarkets();

    // merge
    // 1. latest fills from on-chain
    let allRecentMangoAccountPerpFills: any[] = [];
    // 2. historic from off-chain REST service
    const response = await fetch(
      `https://event-history-api.herokuapp.com/perp_trades/${mangoAccount.publicKey.toBase58()}`
    );
    const responseJson = await response.json();
    const allButRecentMangoAccountPerpFills = responseJson?.data || [];
    for (const config of allMarketConfigs) {
      if (config.kind === "perp") {
        const recentMangoAccountPerpFills: any[] = await allMarkets[
          config.publicKey.toBase58()
        ]
          .loadFills(this.solana.connection)
          .then((fills) => {
            fills = fills.filter(
              (fill) =>
                fill.taker.equals(mangoAccount.publicKey) ||
                fill.maker.equals(mangoAccount.publicKey)
            );

            return fills.map((fill) => ({ ...fill, marketName: config.name }));
          });

        allRecentMangoAccountPerpFills = allRecentMangoAccountPerpFills.concat(
          recentMangoAccountPerpFills
        );
      }
    }
    const newMangoAccountPerpFills = allRecentMangoAccountPerpFills.filter(
      (fill: any) =>
        !allButRecentMangoAccountPerpFills.flat().find((t: any) => {
          if (t.orderId) {
            return t.orderId === fill.orderId?.toString();
          } else {
            return t.seqNum === fill.seqNum?.toString();
          }
        })
    );

    return [...newMangoAccountPerpFills, ...allButRecentMangoAccountPerpFills];
  }

  public async placeOrder(
    mangoAccount: MangoAccount,
    market: string,
    side: "buy" | "sell",
    quantity: number,
    price?: number,
    orderType: "ioc" | "postOnly" | "market" | "limit" = "limit",
    clientOrderId?: number
  ): Promise<TransactionSignature> {
    if (market.includes("PERP")) {
      const perpMarketConfig = getMarketByBaseSymbolAndKind(
        this.mangoGroupConfig,
        market.split("-")[0],
        "perp"
      );
      const perpMarket = await this.mangoGroup.loadPerpMarket(
        this.connection,
        perpMarketConfig.marketIndex,
        perpMarketConfig.baseDecimals,
        perpMarketConfig.quoteDecimals
      );
      // TODO: this is a workaround, mango-v3 has a assertion for price>0 for all order types
      // this will be removed soon hopefully
      price = orderType !== "market" ? price : 1;
      return await this.client.placePerpOrder(
        this.mangoGroup,
        mangoAccount,
        this.mangoGroup.mangoCache,
        perpMarket,
        this.owner,
        side,
        price,
        quantity,
        orderType,
        clientOrderId
      );
    } else {
      // serum doesn't really support market orders, calculate a pseudo market price
      price =
        orderType !== "market"
          ? price
          : await this.calculateMarketOrderPrice(market, quantity, side);

      const spotMarketConfig = getMarketByBaseSymbolAndKind(
        this.mangoGroupConfig,
        market.split("/")[0],
        "spot"
      );
      const spotMarket = await Market.load(
        this.connection,
        spotMarketConfig.publicKey,
        undefined,
        this.mangoGroupConfig.serumProgramId
      );
      return await this.client.placeSpotOrder(
        this.mangoGroup,
        this.mangoAccount,
        this.mangoGroup.mangoCache,
        spotMarket,
        this.owner,
        side,
        price,
        quantity,
        orderType === "market" ? "limit" : orderType,
        new BN(clientOrderId)
      );
    }
  }

  private async calculateMarketOrderPrice(
    market: string,
    quantity: number,
    side: "buy" | "sell"
  ): Promise<number> {
    const bidsAndAsks = await this.fetchAllBidsAndAsks(false, market);

    const bids = bidsAndAsks
      .flat()
      .filter((orderInfo) => orderInfo.order.side === "buy")
      .sort((b1, b2) => b2.order.price - b1.order.price);
    const asks = bidsAndAsks
      .flat()
      .filter((orderInfo) => orderInfo.order.side === "sell")
      .sort((a1, a2) => a1.order.price - a2.order.price);

    const orders: OrderInfo[] = side === "buy" ? asks : bids;

    let acc = 0;
    let selectedOrder;
    for (const order of orders) {
      acc += order.order.size;
      if (acc >= quantity) {
        selectedOrder = order;
        break;
      }
    }

    if (!selectedOrder) {
      throw new Error("Orderbook empty!");
    }

    if (side === "buy") {
      return selectedOrder.order.price * 1.05;
    } else {
      return selectedOrder.order.price * 0.95;
    }
  }

  public async cancelAllOrders(): Promise<void> {
    const allMarkets = await this.fetchMarkets();
    const orders = (await this.fetchAllBidsAndAsks(true)).flat();

    const transactions = await Promise.all(
      orders.map((orderInfo) =>
        this.buildCancelOrderTransaction(
          orderInfo,
          allMarkets[orderInfo.market.account.publicKey.toBase58()]
        )
      )
    );

    let i;
    const j = transactions.length;
    // assuming we can fit 10 cancel order transactions in a solana transaction
    // we could switch to computing actual transactionSize every time we add an
    // instruction and use a dynamic chunk size
    const chunk = 10;
    const transactionsToSend: Transaction[] = [];

    for (i = 0; i < j; i += chunk) {
      const transactionsChunk = transactions.slice(i, i + chunk);
      const transactionToSend = new Transaction();
      for (const transaction of transactionsChunk) {
        for (const instruction of transaction.instructions) {
          transactionToSend.add(instruction);
        }
      }
      transactionsToSend.push(transactionToSend);
    }

    for (const transaction of transactionsToSend) {
      await this.client.sendTransaction(transaction, this.owner, []);
    }
  }

  public async cancelOrder(
    orderInfo: OrderInfo,
    market?: Market | PerpMarket
  ): Promise<TransactionSignature> {
    if (orderInfo.market.config.kind === "perp") {
      const perpMarketConfig = getMarketByBaseSymbolAndKind(
        this.mangoGroupConfig,
        orderInfo.market.config.baseSymbol,
        "perp"
      );
      if (market === undefined) {
        market = await this.mangoGroup.loadPerpMarket(
          this.connection,
          perpMarketConfig.marketIndex,
          perpMarketConfig.baseDecimals,
          perpMarketConfig.quoteDecimals
        );
      }
      return await this.client.cancelPerpOrder(
        this.mangoGroup,
        this.mangoAccount,
        this.owner,
        market as PerpMarket,
        orderInfo.order as PerpOrder
      );
    } else {
      const spotMarketConfig = getMarketByBaseSymbolAndKind(
        this.mangoGroupConfig,
        orderInfo.market.config.baseSymbol,
        "spot"
      );
      if (market === undefined) {
        market = await Market.load(
          this.connection,
          spotMarketConfig.publicKey,
          undefined,
          this.mangoGroupConfig.serumProgramId
        );
      }
      return await this.client.cancelSpotOrder(
        this.mangoGroup,
        this.mangoAccount,
        this.owner,
        market as Market,
        orderInfo.order as Order
      );
    }
  }

  public async buildCancelOrderTransaction(
    orderInfo: OrderInfo,
    market?: Market | PerpMarket
  ): Promise<Transaction> {
    if (orderInfo.market.config.kind === "perp") {
      const perpMarketConfig = getMarketByBaseSymbolAndKind(
        this.mangoGroupConfig,
        orderInfo.market.config.baseSymbol,
        "perp"
      );
      if (market === undefined) {
        market = await this.mangoGroup.loadPerpMarket(
          this.connection,
          perpMarketConfig.marketIndex,
          perpMarketConfig.baseDecimals,
          perpMarketConfig.quoteDecimals
        );
      }
      return this.buildCancelPerpOrderInstruction(
        this.mangoGroup,
        this.mangoAccount,
        this.owner,
        market as PerpMarket,
        orderInfo.order as PerpOrder
      );
    } else {
      const spotMarketConfig = getMarketByBaseSymbolAndKind(
        this.mangoGroupConfig,
        orderInfo.market.config.baseSymbol,
        "spot"
      );
      if (market === undefined) {
        market = await Market.load(
          this.connection,
          spotMarketConfig.publicKey,
          undefined,
          this.mangoGroupConfig.serumProgramId
        );
      }
      return this.buildCancelSpotOrderTransaction(
        this.mangoGroup,
        this.mangoAccount,
        this.owner,
        market as Market,
        orderInfo.order as Order
      );
    }
  }

  public async getOrderByOrderId(orderId: string): Promise<OrderInfo[]> {
    const orders = (await this.fetchAllBidsAndAsks(true)).flat();
    const orderInfos = orders.filter(
      (orderInfo) => orderInfo.order.orderId.toString() === orderId
    );
    return orderInfos;
  }

  public async getOrderByClientId(clientId: string): Promise<OrderInfo[]> {
    const orders = await (await this.fetchAllBidsAndAsks(true)).flat();
    const orderInfos = orders.filter(
      (orderInfo) => orderInfo.order.clientId.toNumber().toString() === clientId
    );
    return orderInfos;
  }

  public async withdraw(
    tokenSymbol: string,
    amount: number
  ): Promise<TransactionSignature> {
    const tokenToWithdraw = getTokenBySymbol(
      this.mangoGroupConfig,
      tokenSymbol
    );
    const tokenIndex = this.mangoGroup.getTokenIndex(tokenToWithdraw.mintKey);
    return this.client.withdraw(
      this.mangoGroup,
      this.mangoAccount,
      this.owner,
      this.mangoGroup.tokens[tokenIndex].rootBank,
      this.mangoGroup.rootBankAccounts[tokenIndex].nodeBankAccounts[0]
        .publicKey,
      this.mangoGroup.rootBankAccounts[tokenIndex].nodeBankAccounts[0].vault,
      Number(amount),
      false
    );
  }

  /// private

  private parseSpotOrders(
    market: Market,
    config: MarketConfig,
    accountInfos: { [key: string]: AccountInfo<Buffer> },
    mangoAccount?: MangoAccount
  ): OrderInfo[] {
    const bidData = accountInfos[market["_decoded"].bids.toBase58()]?.data;
    const askData = accountInfos[market["_decoded"].asks.toBase58()]?.data;

    const bidOrderBook =
      market && bidData ? Orderbook.decode(market, bidData) : ([] as Order[]);
    const askOrderBook =
      market && askData ? Orderbook.decode(market, askData) : ([] as Order[]);

    let openOrdersForMarket = [...bidOrderBook, ...askOrderBook];
    if (mangoAccount !== undefined) {
      const openOrders =
        mangoAccount.spotOpenOrdersAccounts[config.marketIndex];
      if (!openOrders) return [];
      openOrdersForMarket = openOrdersForMarket.filter((o) =>
        o.openOrdersAddress.equals(openOrders.address)
      );
    }

    return openOrdersForMarket.map<OrderInfo>((order) => ({
      order,
      market: { account: market, config },
    }));
  }

  private parsePerpOpenOrders(
    market: PerpMarket,
    config: MarketConfig,
    accountInfos: { [key: string]: AccountInfo<Buffer> },
    mangoAccount?: MangoAccount
  ): OrderInfo[] {
    const bidData = accountInfos[market.bids.toBase58()]?.data;
    const askData = accountInfos[market.asks.toBase58()]?.data;

    const bidOrderBook =
      market && bidData
        ? new BookSide(market.bids, market, BookSideLayout.decode(bidData))
        : ([] as PerpOrder[]);
    const askOrderBook =
      market && askData
        ? new BookSide(market.asks, market, BookSideLayout.decode(askData))
        : ([] as PerpOrder[]);

    let openOrdersForMarket = [...bidOrderBook, ...askOrderBook];
    if (mangoAccount !== undefined) {
      openOrdersForMarket = openOrdersForMarket.filter((o) =>
        o.owner.equals(mangoAccount.publicKey)
      );
    }

    return openOrdersForMarket.map<OrderInfo>((order) => ({
      order,
      market: { account: market, config },
    }));
  }

  private buildCancelPerpOrderInstruction(
    mangoGroup: MangoGroup,
    mangoAccount: MangoAccount,
    owner: Account,
    perpMarket: PerpMarket,
    order: PerpOrder,
    invalidIdOk = false // Don't throw error if order is invalid
  ): Transaction {
    const instruction = makeCancelPerpOrderInstruction(
      this.mangoGroupConfig.mangoProgramId,
      mangoGroup.publicKey,
      mangoAccount.publicKey,
      owner.publicKey,
      perpMarket.publicKey,
      perpMarket.bids,
      perpMarket.asks,
      order,
      invalidIdOk
    );

    const transaction = new Transaction();
    transaction.add(instruction);
    return transaction;
  }

  private async buildCancelSpotOrderTransaction(
    mangoGroup: MangoGroup,
    mangoAccount: MangoAccount,
    owner: Account,
    spotMarket: Market,
    order: Order
  ): Promise<Transaction> {
    const transaction = new Transaction();
    const instruction = makeCancelSpotOrderInstruction(
      this.mangoGroupConfig.mangoProgramId,
      mangoGroup.publicKey,
      owner.publicKey,
      mangoAccount.publicKey,
      spotMarket.programId,
      spotMarket.publicKey,
      spotMarket["_decoded"].bids,
      spotMarket["_decoded"].asks,
      order.openOrdersAddress,
      mangoGroup.signerKey,
      spotMarket["_decoded"].eventQueue,
      order
    );
    transaction.add(instruction);

    const dexSigner = await PublicKey.createProgramAddress(
      [
        spotMarket.publicKey.toBuffer(),
        spotMarket["_decoded"].vaultSignerNonce.toArrayLike(Buffer, "le", 8),
      ],
      spotMarket.programId
    );

    const marketIndex = mangoGroup.getSpotMarketIndex(spotMarket.publicKey);
    if (!mangoGroup.rootBankAccounts.length) {
      await mangoGroup.loadRootBanks(this.solana.connection);
    }
    const baseRootBank = mangoGroup.rootBankAccounts[marketIndex];
    const quoteRootBank = mangoGroup.rootBankAccounts[QUOTE_INDEX];
    const baseNodeBank = baseRootBank?.nodeBankAccounts[0];
    const quoteNodeBank = quoteRootBank?.nodeBankAccounts[0];

    if (!baseNodeBank || !quoteNodeBank) {
      throw new Error("Invalid or missing node banks");
    }

    // todo what is a makeSettleFundsInstruction?
    const settleFundsInstruction = makeSettleFundsInstruction(
      this.mangoGroupConfig.mangoProgramId,
      mangoGroup.publicKey,
      mangoGroup.mangoCache,
      owner.publicKey,
      mangoAccount.publicKey,
      spotMarket.programId,
      spotMarket.publicKey,
      mangoAccount.spotOpenOrders[marketIndex],
      mangoGroup.signerKey,
      spotMarket["_decoded"].baseVault,
      spotMarket["_decoded"].quoteVault,
      mangoGroup.tokens[marketIndex].rootBank,
      baseNodeBank.publicKey,
      mangoGroup.tokens[QUOTE_INDEX].rootBank,
      quoteNodeBank.publicKey,
      baseNodeBank.vault,
      quoteNodeBank.vault,
      dexSigner
    );
    transaction.add(settleFundsInstruction);

    return transaction;
  } **/
}

export default Mango;
