// ============================================================================
// TastyScanner MCP — Strategy Builder
// Server-side replication of main app's strategies-builder.ts logic
// Builds Iron Condors and credit spreads from options chain data
// ============================================================================

import { TastyClient, GreeksData, QuoteData } from "./tasty-client.js";
import { StrategySetup, StrategyLeg } from "./types.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Configuration defaults (mirrors main app's strategy-settings)
// ---------------------------------------------------------------------------

export interface StrategyFilterConfig {
  minDelta: number;       // 0.10
  maxDelta: number;       // 0.30
  wings: number[];        // [1, 2, 3, 5, 10]
  condorsMinDelta: number; // -5
  condorsMaxDelta: number; // 5
  maxBidAskSpread: number; // 0.50
  minDTE: number;          // 20
  maxDTE: number;          // 60
}

const DEFAULT_FILTERS: StrategyFilterConfig = {
  minDelta: 0.10,
  maxDelta: 0.30,
  wings: [1, 2, 3, 5, 10],
  condorsMinDelta: -5,
  condorsMaxDelta: 5,
  maxBidAskSpread: 0.50,
  minDTE: 20,
  maxDTE: 60,
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ParsedStrike {
  strikePrice: number;
  callSymbol: string;
  putSymbol: string;
  callStreamer: string;
  putStreamer: string;
}

interface ParsedExpiration {
  expirationDate: string;
  daysToExpiration: number;
  expirationType: string;
  strikes: ParsedStrike[];
}

interface OptionData {
  symbol: string;
  streamerSymbol: string;
  strikePrice: number;
  type: "Put" | "Call";
  expirationDate: string;
  dte: number;
  bidPrice: number;
  askPrice: number;
  midPrice: number;
  delta: number;
  absDelta: number;
  theta: number;
  bidAskSpread: number;
}

interface CreditSpread {
  stoOption: OptionData;
  btoOption: OptionData;
  wingsWidth: number;
  credit: number;
  riskRewardRatio: number;
  delta: number;
  theta: number;
  type: "put" | "call";
}

// ---------------------------------------------------------------------------
// StrategyBuilder
// ---------------------------------------------------------------------------

export class StrategyBuilder {
  private filters: StrategyFilterConfig;

  constructor(
    private tastyClient: TastyClient,
    filters?: Partial<StrategyFilterConfig>,
  ) {
    this.filters = { ...DEFAULT_FILTERS, ...filters };
  }

  /**
   * Build all Iron Condor setups for a given symbol
   * This replicates the logic from:
   *   - src/app/models/strategies-builder.ts (ironCondors getter)
   *   - src/app/models/iron-condor.model.ts
   */
  async buildStrategies(symbol: string): Promise<StrategySetup[]> {
    logger.info(`[StrategyBuilder] Building strategies for ${symbol}`);

    // 1. Fetch the options chain
    const rawChain = await this.tastyClient.getOptionsChain(symbol);
    if (!rawChain) {
      logger.warn(`[StrategyBuilder] No options chain for ${symbol}`);
      return [];
    }

    // 2. Parse chain into our format
    const expirations = this._parseChain(rawChain);

    // 3. Filter by DTE
    const validExpirations = expirations.filter(
      (exp) => exp.daysToExpiration >= this.filters.minDTE &&
               exp.daysToExpiration <= this.filters.maxDTE,
    );

    logger.info(
      `[StrategyBuilder] ${validExpirations.length} expirations in DTE range ` +
      `[${this.filters.minDTE}-${this.filters.maxDTE}]`,
    );

    // 4. Subscribe to streamer for all options in range, wait for data
    const allStreamerSymbols: string[] = [];
    for (const exp of validExpirations) {
      for (const strike of exp.strikes) {
        allStreamerSymbols.push(strike.callStreamer, strike.putStreamer);
      }
    }

    if (allStreamerSymbols.length > 0) {
      await this.tastyClient.subscribeToSymbols(allStreamerSymbols);
      // Give streamer a moment to populate data
      await this._waitForData(allStreamerSymbols.slice(0, 10), 5000);
    }

    // 5. Build strategies per expiration
    const allStrategies: StrategySetup[] = [];

    for (const exp of validExpirations) {
      const puts = this._buildOptionDataList(exp, "Put");
      const calls = this._buildOptionDataList(exp, "Call");

      // Filter by delta
      const filteredPuts = puts.filter(
        (o) => o.absDelta >= this.filters.minDelta &&
               o.absDelta <= this.filters.maxDelta &&
               o.midPrice > 0,
      );
      const filteredCalls = calls.filter(
        (o) => o.absDelta >= this.filters.minDelta &&
               o.absDelta <= this.filters.maxDelta &&
               o.midPrice > 0,
      );

      // Build credit spreads
      const putSpreads = this._buildCreditSpreads(filteredPuts, exp.strikes, "put");
      const callSpreads = this._buildCreditSpreads(filteredCalls, exp.strikes, "call");

      // Build Iron Condors by combining put + call spreads with same wings
      const putByWings = this._groupBy(putSpreads, (s) => s.wingsWidth.toString());
      const callByWings = this._groupBy(callSpreads, (s) => s.wingsWidth.toString());

      for (const wing of Object.keys(putByWings)) {
        const putGroup = putByWings[wing];
        const callGroup = callByWings[wing];
        if (!callGroup) continue;

        for (const ps of putGroup) {
          for (const cs of callGroup) {
            const condor = this._buildIronCondor(ps, cs, exp);
            if (
              condor.delta >= this.filters.condorsMinDelta &&
              condor.delta <= this.filters.condorsMaxDelta
            ) {
              allStrategies.push(condor);
            }
          }
        }
      }
    }

    // Sort by rr_ratio descending (lower ratio = better reward for the risk)
    allStrategies.sort((a, b) => a.rr_ratio - b.rr_ratio);

    logger.info(
      `[StrategyBuilder] Found ${allStrategies.length} Iron Condor setups for ${symbol}`,
    );

    return allStrategies;
  }

  // -------------------------------------------------------------------------
  // Chain parsing
  // -------------------------------------------------------------------------

  private _parseChain(rawChain: any): ParsedExpiration[] {
    // Handle both SDK response shapes
    const expirations: any[] =
      rawChain?.expirations ?? rawChain?.data?.items ?? rawChain ?? [];

    if (!Array.isArray(expirations)) return [];

    return expirations
      .map((exp: any) => {
        const strikes = (exp.strikes ?? []).map((s: any) => ({
          strikePrice: s["strike-price"] ?? s.strikePrice ?? 0,
          callSymbol: s.call ?? s.callId ?? "",
          putSymbol: s.put ?? s.putId ?? "",
          callStreamer: s["call-streamer-symbol"] ?? s.callStreamerSymbol ?? s.call ?? "",
          putStreamer: s["put-streamer-symbol"] ?? s.putStreamerSymbol ?? s.put ?? "",
        }));

        return {
          expirationDate: exp["expiration-date"] ?? exp.expirationDate ?? "",
          daysToExpiration: exp["days-to-expiration"] ?? exp.daysToExpiration ?? 0,
          expirationType: exp["expiration-type"] ?? exp.expirationType ?? "",
          strikes,
        };
      })
      .filter((exp: ParsedExpiration) => exp.strikes.length > 0);
  }

  // -------------------------------------------------------------------------
  // Option data from streamer cache
  // -------------------------------------------------------------------------

  private _buildOptionDataList(
    exp: ParsedExpiration,
    type: "Put" | "Call",
  ): OptionData[] {
    const results: OptionData[] = [];

    for (const strike of exp.strikes) {
      const streamerSym = type === "Put" ? strike.putStreamer : strike.callStreamer;
      const symbol = type === "Put" ? strike.putSymbol : strike.callSymbol;

      const quote = this.tastyClient.getQuote(streamerSym);
      const greeks = this.tastyClient.getGreeks(streamerSym);

      const bidPrice = quote?.bidPrice ?? 0;
      const askPrice = quote?.askPrice ?? 0;
      const midPrice = round((bidPrice + askPrice) / 2);
      const delta = greeks?.delta ?? 0;
      const theta = greeks?.theta ?? 0;

      results.push({
        symbol,
        streamerSymbol: streamerSym,
        strikePrice: strike.strikePrice,
        type,
        expirationDate: exp.expirationDate,
        dte: exp.daysToExpiration,
        bidPrice,
        askPrice,
        midPrice,
        delta,
        absDelta: Math.abs(delta),
        theta,
        bidAskSpread: round(askPrice - bidPrice),
      });
    }

    return results.sort((a, b) => b.absDelta - a.absDelta);
  }

  // -------------------------------------------------------------------------
  // Credit spread building (mirrors _buildCreditSpreads in strategies-builder)
  // -------------------------------------------------------------------------

  private _buildCreditSpreads(
    options: OptionData[],
    allStrikes: ParsedStrike[],
    type: "put" | "call",
  ): CreditSpread[] {
    const spreads: CreditSpread[] = [];
    const wingSign = type === "put" ? -1 : 1;

    for (const stoOption of options) {
      if (stoOption.midPrice <= 0) continue;

      for (const wingWidth of this.filters.wings) {
        const targetStrike = round(stoOption.strikePrice + wingSign * wingWidth, 4);
        const btoStrike = allStrikes.find(
          (s) => Math.abs(s.strikePrice - targetStrike) < 0.01,
        );
        if (!btoStrike) continue;

        const btoStreamer = type === "put"
          ? btoStrike.putStreamer
          : btoStrike.callStreamer;
        const btoSymbol = type === "put" ? btoStrike.putSymbol : btoStrike.callSymbol;

        const btoQuote = this.tastyClient.getQuote(btoStreamer);
        const btoGreeks = this.tastyClient.getGreeks(btoStreamer);
        const btoBid = btoQuote?.bidPrice ?? 0;
        const btoAsk = btoQuote?.askPrice ?? 0;
        const btoMid = round((btoBid + btoAsk) / 2);

        if (btoMid <= 0) continue;

        // Check bid-ask spread quality
        const stoBAS = stoOption.bidAskSpread;
        const btoBAS = round(btoAsk - btoBid);
        if (stoBAS > this.filters.maxBidAskSpread || btoBAS > this.filters.maxBidAskSpread) {
          continue;
        }
        if (stoBAS < 0 || btoBAS < 0) continue;

        const btoOption: OptionData = {
          symbol: btoSymbol,
          streamerSymbol: btoStreamer,
          strikePrice: btoStrike.strikePrice,
          type: type === "put" ? "Put" : "Call",
          expirationDate: stoOption.expirationDate,
          dte: stoOption.dte,
          bidPrice: btoBid,
          askPrice: btoAsk,
          midPrice: btoMid,
          delta: btoGreeks?.delta ?? 0,
          absDelta: Math.abs(btoGreeks?.delta ?? 0),
          theta: btoGreeks?.theta ?? 0,
          bidAskSpread: btoBAS,
        };

        const credit = round(stoOption.midPrice - btoMid);
        if (credit <= 0) continue;

        spreads.push({
          stoOption,
          btoOption,
          wingsWidth: wingWidth,
          credit,
          riskRewardRatio: round(wingWidth / credit),
          delta: round(stoOption.delta + btoOption.delta),
          theta: round(stoOption.theta + btoOption.theta),
          type,
        });
      }
    }

    return spreads;
  }

  // -------------------------------------------------------------------------
  // Iron Condor assembly (mirrors IronCondorModel)
  // -------------------------------------------------------------------------

  private _buildIronCondor(
    putSpread: CreditSpread,
    callSpread: CreditSpread,
    exp: ParsedExpiration,
  ): StrategySetup {
    const totalCredit = round(putSpread.credit + callSpread.credit);
    const wings = putSpread.wingsWidth; // same for both sides
    const maxLoss = round(wings - totalCredit);
    const rrRatio = round(wings / totalCredit);

    // POP calculation (same logic as IronCondorModel.pop)
    const putBreakEven = putSpread.stoOption.strikePrice - totalCredit;
    const callBreakEven = callSpread.stoOption.strikePrice + totalCredit;

    // Simplified POP: find delta at break-even strikes
    const putBEDelta = this._findDeltaAtStrike(exp, putBreakEven, "put");
    const callBEDelta = this._findDeltaAtStrike(exp, callBreakEven, "call");
    const pop = round((1 - (Math.abs(putBEDelta) + Math.abs(callBEDelta))) * 100);

    const legs: StrategyLeg[] = [
      {
        action: "BTO",
        type: "Put",
        strike: putSpread.btoOption.strikePrice,
        price: putSpread.btoOption.midPrice,
        delta: round(putSpread.btoOption.delta),
        spread: putSpread.btoOption.bidAskSpread,
      },
      {
        action: "STO",
        type: "Put",
        strike: putSpread.stoOption.strikePrice,
        price: putSpread.stoOption.midPrice,
        delta: round(putSpread.stoOption.delta),
        spread: putSpread.stoOption.bidAskSpread,
      },
      {
        action: "STO",
        type: "Call",
        strike: callSpread.stoOption.strikePrice,
        price: callSpread.stoOption.midPrice,
        delta: round(callSpread.stoOption.delta),
        spread: callSpread.stoOption.bidAskSpread,
      },
      {
        action: "BTO",
        type: "Call",
        strike: callSpread.btoOption.strikePrice,
        price: callSpread.btoOption.midPrice,
        delta: round(callSpread.btoOption.delta),
        spread: callSpread.btoOption.bidAskSpread,
      },
    ];

    return {
      strategy_name: "Iron Condor",
      expiry_date: exp.expirationDate,
      dte: exp.daysToExpiration,
      legs,
      credit: totalCredit,
      max_profit: totalCredit,
      max_loss: maxLoss,
      rr_ratio: rrRatio,
      pop,
      theta: round(putSpread.theta + callSpread.theta),
      delta: round(putSpread.delta + callSpread.delta),
      wings,
      bpe: maxLoss, // buying power effect ≈ max loss for IC
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private _findDeltaAtStrike(
    exp: ParsedExpiration,
    targetStrike: number,
    type: "put" | "call",
  ): number {
    // Find the closest strike to the target
    let closest: ParsedStrike | null = null;
    let minDiff = Infinity;

    for (const strike of exp.strikes) {
      const diff = type === "put"
        ? targetStrike - strike.strikePrice  // for puts, find strike below
        : strike.strikePrice - targetStrike; // for calls, find strike above

      if (diff >= 0 && diff < minDiff) {
        minDiff = diff;
        closest = strike;
      }
    }

    if (!closest) return 0;

    const streamer = type === "put" ? closest.putStreamer : closest.callStreamer;
    const greeks = this.tastyClient.getGreeks(streamer);
    return greeks?.delta ?? 0;
  }

  private _groupBy<T>(arr: T[], keyFn: (item: T) => string): Record<string, T[]> {
    const result: Record<string, T[]> = {};
    for (const item of arr) {
      const key = keyFn(item);
      (result[key] ??= []).push(item);
    }
    return result;
  }

  private async _waitForData(
    sampleSymbols: string[],
    maxWaitMs: number,
  ): Promise<void> {
    const start = Date.now();
    const checkInterval = 200;

    while (Date.now() - start < maxWaitMs) {
      const hasData = sampleSymbols.some(
        (sym) => this.tastyClient.getQuote(sym) !== undefined,
      );
      if (hasData) {
        logger.debug("[StrategyBuilder] Streamer data arrived");
        return;
      }
      await new Promise((r) => setTimeout(r, checkInterval));
    }

    logger.warn("[StrategyBuilder] Timed out waiting for streamer data");
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function round(value: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
