// ============================================================================
// TastyScanner MCP — Strategy Builder (all 12 strategies)
// Server-side replication of src/app/models/strategies-builder.ts
//
// Credit strategies (sell premium, positive theta):
//   1. Iron Condor         — put spread + call spread, different short strikes
//   2. Put Credit Spread   — STO put + BTO put below
//   3. Call Credit Spread  — STO call + BTO call above
//   4. Iron Butterfly      — like IC but short strikes at same ATM price
//   5. Jade Lizard         — naked STO put + call credit spread (zero upside risk)
//   6. Twisted Sister      — naked STO call + put credit spread (zero downside risk)
//
// Debit strategies (buy premium, negative theta):
//   7. Long Straddle       — BTO put + BTO call at same strike
//   8. Long Strangle       — BTO put + BTO call at different OTM strikes
//   9. Bull Call Spread    — BTO call (lower) + STO call (higher)
//  10. Bear Put Spread     — BTO put (higher) + STO put (lower)
//  11. Call Butterfly       — BTO lower + 2×STO mid + BTO upper (calls)
//  12. Put Butterfly        — BTO lower + 2×STO mid + BTO upper (puts)
// ============================================================================

import { TastyClient } from "./tasty-client.js";
import { StrategySetup, StrategyLeg } from "./types.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Strategy type enum — matches what DeerFlow can request
// ---------------------------------------------------------------------------

export type StrategyType =
  | "all"
  | "iron_condor"
  | "put_credit_spread"
  | "call_credit_spread"
  | "iron_butterfly"
  | "jade_lizard"
  | "twisted_sister"
  | "long_straddle"
  | "long_strangle"
  | "bull_call_spread"
  | "bear_put_spread"
  | "call_butterfly"
  | "put_butterfly";

// ---------------------------------------------------------------------------
// Configuration defaults (mirrors main app's strategy-settings)
// ---------------------------------------------------------------------------

export interface StrategyFilterConfig {
  minDelta: number;        // 0.10 — credit strategy short strike min delta
  maxDelta: number;        // 0.30 — credit strategy short strike max delta
  debitMinDelta: number;   // 0.30 — debit strategy long strike min delta
  debitMaxDelta: number;   // 0.50 — debit strategy long strike max delta
  wings: number[];         // [1, 2, 3, 5, 10]
  condorsMinDelta: number; // -5
  condorsMaxDelta: number; // 5
  maxBidAskSpread: number; // 0.50
  minDTE: number;          // 20
  maxDTE: number;          // 60
}

const DEFAULT_FILTERS: StrategyFilterConfig = {
  minDelta: 0.10,
  maxDelta: 0.30,
  debitMinDelta: 0.30,
  debitMaxDelta: 0.50,
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
   * Build strategies for a given symbol and type.
   * If type="all", builds all 12 strategy types.
   */
  async buildStrategies(
    symbol: string,
    strategyType: StrategyType = "all",
  ): Promise<StrategySetup[]> {
    logger.info(`[StrategyBuilder] Building ${strategyType} for ${symbol}`);

    const rawChain = await this.tastyClient.getOptionsChain(symbol);
    if (!rawChain) {
      logger.warn(`[StrategyBuilder] No options chain for ${symbol}`);
      return [];
    }

    const expirations = this._parseChain(rawChain);
    const validExpirations = expirations.filter(
      (exp) =>
        exp.daysToExpiration >= this.filters.minDTE &&
        exp.daysToExpiration <= this.filters.maxDTE,
    );

    logger.info(
      `[StrategyBuilder] ${validExpirations.length} expirations in DTE [${this.filters.minDTE}-${this.filters.maxDTE}]`,
    );

    // Subscribe to streamer and wait for data
    const allStreamerSymbols: string[] = [];
    for (const exp of validExpirations) {
      for (const strike of exp.strikes) {
        allStreamerSymbols.push(strike.callStreamer, strike.putStreamer);
      }
    }
    if (allStreamerSymbols.length > 0) {
      await this.tastyClient.subscribeToSymbols(allStreamerSymbols);
      await this._waitForData(allStreamerSymbols.slice(0, 10), 5000);
    }

    // Build per expiration
    const allStrategies: StrategySetup[] = [];

    for (const exp of validExpirations) {
      const puts = this._buildOptionDataList(exp, "Put");
      const calls = this._buildOptionDataList(exp, "Call");

      // Credit-filtered options (delta 0.10-0.30)
      const creditPuts = this._filterByDelta(puts, this.filters.minDelta, this.filters.maxDelta);
      const creditCalls = this._filterByDelta(calls, this.filters.minDelta, this.filters.maxDelta);

      // Debit-filtered options (delta 0.30-0.50)
      const debitPuts = this._filterByDelta(puts, this.filters.debitMinDelta, this.filters.debitMaxDelta);
      const debitCalls = this._filterByDelta(calls, this.filters.debitMinDelta, this.filters.debitMaxDelta);

      // Credit spreads (foundation for IC, IB, JL, TS)
      const putSpreads = this._buildCreditSpreads(creditPuts, exp.strikes, "put");
      const callSpreads = this._buildCreditSpreads(creditCalls, exp.strikes, "call");

      // ── Credit strategies ──

      if (strategyType === "all" || strategyType === "put_credit_spread") {
        for (const ps of putSpreads) {
          allStrategies.push(this._toPutCreditSpread(ps, exp));
        }
      }

      if (strategyType === "all" || strategyType === "call_credit_spread") {
        for (const cs of callSpreads) {
          allStrategies.push(this._toCallCreditSpread(cs, exp));
        }
      }

      if (strategyType === "all" || strategyType === "iron_condor") {
        allStrategies.push(...this._buildIronCondors(putSpreads, callSpreads, exp));
      }

      if (strategyType === "all" || strategyType === "iron_butterfly") {
        allStrategies.push(...this._buildIronButterflies(putSpreads, callSpreads, exp));
      }

      if (strategyType === "all" || strategyType === "jade_lizard") {
        allStrategies.push(...this._buildJadeLizards(creditPuts, callSpreads, exp));
      }

      if (strategyType === "all" || strategyType === "twisted_sister") {
        allStrategies.push(...this._buildTwistedSisters(creditCalls, putSpreads, exp));
      }

      // ── Debit strategies ──

      if (strategyType === "all" || strategyType === "long_straddle") {
        allStrategies.push(...this._buildLongStraddles(debitPuts, debitCalls, exp));
      }

      if (strategyType === "all" || strategyType === "long_strangle") {
        allStrategies.push(...this._buildLongStrangles(debitPuts, debitCalls, exp));
      }

      if (strategyType === "all" || strategyType === "bull_call_spread") {
        allStrategies.push(...this._buildBullCallSpreads(debitCalls, exp));
      }

      if (strategyType === "all" || strategyType === "bear_put_spread") {
        allStrategies.push(...this._buildBearPutSpreads(debitPuts, exp));
      }

      if (strategyType === "all" || strategyType === "call_butterfly") {
        allStrategies.push(...this._buildCallButterflies(creditCalls, exp));
      }

      if (strategyType === "all" || strategyType === "put_butterfly") {
        allStrategies.push(...this._buildPutButterflies(creditPuts, exp));
      }
    }

    allStrategies.sort((a, b) => a.rr_ratio - b.rr_ratio);

    logger.info(`[StrategyBuilder] Found ${allStrategies.length} setups for ${symbol} (${strategyType})`);
    return allStrategies;
  }

  // =========================================================================
  // Credit strategy builders
  // =========================================================================

  private _toPutCreditSpread(ps: CreditSpread, exp: ParsedExpiration): StrategySetup {
    const maxLoss = round(ps.wingsWidth - ps.credit);
    return {
      strategy_name: "Put Credit Spread",
      expiry_date: exp.expirationDate,
      dte: exp.daysToExpiration,
      legs: [
        this._leg("BTO", "Put", ps.btoOption),
        this._leg("STO", "Put", ps.stoOption),
      ],
      credit: ps.credit,
      max_profit: ps.credit,
      max_loss: maxLoss,
      rr_ratio: ps.riskRewardRatio,
      pop: round(100 - ps.stoOption.absDelta * 100),
      theta: ps.theta,
      delta: ps.delta,
      wings: ps.wingsWidth,
      bpe: maxLoss,
      price_effect: "Credit",
    };
  }

  private _toCallCreditSpread(cs: CreditSpread, exp: ParsedExpiration): StrategySetup {
    const maxLoss = round(cs.wingsWidth - cs.credit);
    return {
      strategy_name: "Call Credit Spread",
      expiry_date: exp.expirationDate,
      dte: exp.daysToExpiration,
      legs: [
        this._leg("STO", "Call", cs.stoOption),
        this._leg("BTO", "Call", cs.btoOption),
      ],
      credit: cs.credit,
      max_profit: cs.credit,
      max_loss: maxLoss,
      rr_ratio: cs.riskRewardRatio,
      pop: round(100 - cs.stoOption.absDelta * 100),
      theta: cs.theta,
      delta: cs.delta,
      wings: cs.wingsWidth,
      bpe: maxLoss,
      price_effect: "Credit",
    };
  }

  private _buildIronCondors(
    putSpreads: CreditSpread[],
    callSpreads: CreditSpread[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    const putByWings = groupBy(putSpreads, (s) => s.wingsWidth.toString());
    const callByWings = groupBy(callSpreads, (s) => s.wingsWidth.toString());

    for (const wing of Object.keys(putByWings)) {
      const pGroup = putByWings[wing];
      const cGroup = callByWings[wing];
      if (!cGroup) continue;
      for (const ps of pGroup) {
        for (const cs of cGroup) {
          const credit = round(ps.credit + cs.credit);
          const wings = ps.wingsWidth;
          const maxLoss = round(wings - credit);
          const delta = round(ps.delta + cs.delta);
          if (delta < this.filters.condorsMinDelta || delta > this.filters.condorsMaxDelta) continue;

          const pop = this._calcIronCondorPop(ps, cs, credit, exp);

          results.push({
            strategy_name: "Iron Condor",
            expiry_date: exp.expirationDate,
            dte: exp.daysToExpiration,
            legs: [
              this._leg("BTO", "Put", ps.btoOption),
              this._leg("STO", "Put", ps.stoOption),
              this._leg("STO", "Call", cs.stoOption),
              this._leg("BTO", "Call", cs.btoOption),
            ],
            credit,
            max_profit: credit,
            max_loss: maxLoss,
            rr_ratio: round(wings / credit),
            pop,
            theta: round(ps.theta + cs.theta),
            delta,
            wings,
            bpe: maxLoss,
            price_effect: "Credit",
          });
        }
      }
    }
    return results;
  }

  private _buildIronButterflies(
    putSpreads: CreditSpread[],
    callSpreads: CreditSpread[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    const putByWings = groupBy(putSpreads, (s) => s.wingsWidth.toString());
    const callByWings = groupBy(callSpreads, (s) => s.wingsWidth.toString());

    for (const wing of Object.keys(putByWings)) {
      const pGroup = putByWings[wing];
      const cGroup = callByWings[wing];
      if (!cGroup) continue;
      for (const ps of pGroup) {
        for (const cs of cGroup) {
          // Iron Butterfly: STO put and STO call at SAME strike (ATM)
          if (ps.stoOption.strikePrice !== cs.stoOption.strikePrice) continue;

          const credit = round(ps.credit + cs.credit);
          const wings = ps.wingsWidth;
          const maxLoss = round(wings - credit);
          const pop = this._calcIronCondorPop(ps, cs, credit, exp);

          results.push({
            strategy_name: "Iron Butterfly",
            expiry_date: exp.expirationDate,
            dte: exp.daysToExpiration,
            legs: [
              this._leg("BTO", "Put", ps.btoOption),
              this._leg("STO", "Put", ps.stoOption),
              this._leg("STO", "Call", cs.stoOption),
              this._leg("BTO", "Call", cs.btoOption),
            ],
            credit,
            max_profit: credit,
            max_loss: maxLoss,
            rr_ratio: round(wings / credit),
            pop,
            theta: round(ps.theta + cs.theta),
            delta: round(ps.delta + cs.delta),
            wings,
            bpe: maxLoss,
            price_effect: "Credit",
          });
        }
      }
    }
    return results;
  }

  private _buildJadeLizards(
    puts: OptionData[],
    callSpreads: CreditSpread[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const put of puts) {
      for (const cs of callSpreads) {
        const credit = round(put.midPrice + cs.credit);
        // Jade Lizard condition: credit >= wings → zero upside risk
        if (credit < cs.wingsWidth) continue;

        const maxRisk = round(put.strikePrice - credit);
        if (maxRisk <= 0) continue;

        results.push({
          strategy_name: "Jade Lizard",
          expiry_date: exp.expirationDate,
          dte: exp.daysToExpiration,
          legs: [
            this._leg("STO", "Put", put),
            this._leg("STO", "Call", cs.stoOption),
            this._leg("BTO", "Call", cs.btoOption),
          ],
          credit,
          max_profit: credit,
          max_loss: maxRisk,
          rr_ratio: round(maxRisk / credit),
          pop: round(100 - put.absDelta * 100),
          theta: round((put.theta + cs.stoOption.theta - cs.btoOption.theta) * 100),
          delta: round((put.delta + cs.stoOption.delta - cs.btoOption.delta) * 100),
          wings: cs.wingsWidth,
          bpe: maxRisk,
          price_effect: "Credit",
        });
      }
    }
    return results;
  }

  private _buildTwistedSisters(
    calls: OptionData[],
    putSpreads: CreditSpread[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const call of calls) {
      for (const ps of putSpreads) {
        const credit = round(call.midPrice + ps.credit);
        // Twisted Sister condition: credit >= wings → zero downside risk
        if (credit < ps.wingsWidth) continue;

        const maxRisk = round(call.strikePrice - credit);
        if (maxRisk <= 0) continue;

        results.push({
          strategy_name: "Twisted Sister",
          expiry_date: exp.expirationDate,
          dte: exp.daysToExpiration,
          legs: [
            this._leg("BTO", "Put", ps.btoOption),
            this._leg("STO", "Put", ps.stoOption),
            this._leg("STO", "Call", call),
          ],
          credit,
          max_profit: credit,
          max_loss: maxRisk,
          rr_ratio: round(maxRisk / credit),
          pop: round(100 - call.absDelta * 100),
          theta: round((ps.stoOption.theta - ps.btoOption.theta + call.theta) * 100),
          delta: round((ps.stoOption.delta - ps.btoOption.delta + call.delta) * 100),
          wings: ps.wingsWidth,
          bpe: maxRisk,
          price_effect: "Credit",
        });
      }
    }
    return results;
  }

  // =========================================================================
  // Debit strategy builders
  // =========================================================================

  private _buildLongStraddles(
    puts: OptionData[],
    calls: OptionData[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const put of puts) {
      const call = calls.find((c) => c.strikePrice === put.strikePrice);
      if (!call) continue;
      if (!this._hasGoodBAS([put, call])) continue;

      const debit = round(put.midPrice + call.midPrice);
      if (debit <= 0) continue;

      results.push({
        strategy_name: "Long Straddle",
        expiry_date: exp.expirationDate,
        dte: exp.daysToExpiration,
        legs: [
          this._leg("BTO", "Put", put),
          this._leg("BTO", "Call", call),
        ],
        credit: round(-debit),
        max_profit: -1, // unlimited
        max_loss: debit,
        rr_ratio: round(put.strikePrice / debit),
        pop: round((put.absDelta * 100 + call.absDelta * 100) / 2),
        theta: round((put.theta + call.theta) * 100),
        delta: round((put.delta + call.delta) * 100),
        wings: 0,
        bpe: debit,
        price_effect: "Debit",
      });
    }
    return results;
  }

  private _buildLongStrangles(
    puts: OptionData[],
    calls: OptionData[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const put of puts) {
      for (const call of calls) {
        if (put.strikePrice >= call.strikePrice) continue;
        if (!this._hasGoodBAS([put, call])) continue;

        const debit = round(put.midPrice + call.midPrice);
        if (debit <= 0) continue;

        const width = round(call.strikePrice - put.strikePrice);

        results.push({
          strategy_name: "Long Strangle",
          expiry_date: exp.expirationDate,
          dte: exp.daysToExpiration,
          legs: [
            this._leg("BTO", "Put", put),
            this._leg("BTO", "Call", call),
          ],
          credit: round(-debit),
          max_profit: -1, // unlimited
          max_loss: debit,
          rr_ratio: round(width / debit),
          pop: round((put.absDelta * 100 + call.absDelta * 100) / 2),
          theta: round((put.theta + call.theta) * 100),
          delta: round((put.delta + call.delta) * 100),
          wings: width,
          bpe: debit,
          price_effect: "Debit",
        });
      }
    }
    return results;
  }

  private _buildBullCallSpreads(
    calls: OptionData[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const btoCall of calls) {
      for (const wingWidth of this.filters.wings) {
        const stoStrike = exp.strikes.find(
          (s) => Math.abs(s.strikePrice - (btoCall.strikePrice + wingWidth)) < 0.01,
        );
        if (!stoStrike) continue;

        const stoCall = this._getOptionData(stoStrike, exp, "Call");
        if (!stoCall || stoCall.midPrice <= 0) continue;
        if (!this._hasGoodBAS([btoCall, stoCall])) continue;

        const debit = round(btoCall.midPrice - stoCall.midPrice);
        if (debit <= 0 || debit >= wingWidth) continue;

        const maxProfit = round(wingWidth - debit);

        results.push({
          strategy_name: "Bull Call Spread",
          expiry_date: exp.expirationDate,
          dte: exp.daysToExpiration,
          legs: [
            this._leg("BTO", "Call", btoCall),
            this._leg("STO", "Call", stoCall),
          ],
          credit: round(-debit),
          max_profit: maxProfit,
          max_loss: debit,
          rr_ratio: round(debit / maxProfit),
          pop: round(100 - btoCall.absDelta * 100),
          theta: round((btoCall.theta - stoCall.theta) * 100),
          delta: round((btoCall.delta - stoCall.delta) * 100),
          wings: wingWidth,
          bpe: debit,
          price_effect: "Debit",
        });
      }
    }
    return results;
  }

  private _buildBearPutSpreads(
    puts: OptionData[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const btoPut of puts) {
      for (const wingWidth of this.filters.wings) {
        const stoStrike = exp.strikes.find(
          (s) => Math.abs(s.strikePrice - (btoPut.strikePrice - wingWidth)) < 0.01,
        );
        if (!stoStrike) continue;

        const stoPut = this._getOptionData(stoStrike, exp, "Put");
        if (!stoPut || stoPut.midPrice <= 0) continue;
        if (!this._hasGoodBAS([btoPut, stoPut])) continue;

        const debit = round(btoPut.midPrice - stoPut.midPrice);
        if (debit <= 0 || debit >= wingWidth) continue;

        const maxProfit = round(wingWidth - debit);

        results.push({
          strategy_name: "Bear Put Spread",
          expiry_date: exp.expirationDate,
          dte: exp.daysToExpiration,
          legs: [
            this._leg("BTO", "Put", btoPut),
            this._leg("STO", "Put", stoPut),
          ],
          credit: round(-debit),
          max_profit: maxProfit,
          max_loss: debit,
          rr_ratio: round(debit / maxProfit),
          pop: round(100 - btoPut.absDelta * 100),
          theta: round((btoPut.theta - stoPut.theta) * 100),
          delta: round((btoPut.delta - stoPut.delta) * 100),
          wings: wingWidth,
          bpe: debit,
          price_effect: "Debit",
        });
      }
    }
    return results;
  }

  private _buildCallButterflies(
    calls: OptionData[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const stoCall of calls) {
      for (const lowerWing of this.filters.wings) {
        const lowerStrike = exp.strikes.find(
          (s) => Math.abs(s.strikePrice - (stoCall.strikePrice - lowerWing)) < 0.01,
        );
        if (!lowerStrike) continue;
        const btoLower = this._getOptionData(lowerStrike, exp, "Call");
        if (!btoLower || btoLower.midPrice <= 0) continue;

        for (const upperWing of this.filters.wings) {
          const upperStrike = exp.strikes.find(
            (s) => Math.abs(s.strikePrice - (stoCall.strikePrice + upperWing)) < 0.01,
          );
          if (!upperStrike) continue;
          const btoUpper = this._getOptionData(upperStrike, exp, "Call");
          if (!btoUpper || btoUpper.midPrice <= 0) continue;
          if (!this._hasGoodBAS([btoLower, stoCall, btoUpper])) continue;

          // Debit = BTO lower + BTO upper - 2×STO mid
          const debit = round(btoLower.midPrice - 2 * stoCall.midPrice + btoUpper.midPrice);
          const isCredit = debit < 0;
          if (debit <= 0 && !isCredit) continue;

          const maxProfit = round(lowerWing - debit);
          const name = lowerWing !== upperWing ? "Broken Wing Call Butterfly" : "Call Butterfly";

          results.push({
            strategy_name: name,
            expiry_date: exp.expirationDate,
            dte: exp.daysToExpiration,
            legs: [
              this._leg("BTO", "Call", btoLower),
              { action: "STO", type: "Call", strike: stoCall.strikePrice, price: stoCall.midPrice, delta: round(stoCall.delta), spread: stoCall.bidAskSpread, quantity: 2 },
              this._leg("BTO", "Call", btoUpper),
            ],
            credit: round(-debit),
            max_profit: maxProfit,
            max_loss: isCredit ? 0 : debit,
            rr_ratio: maxProfit > 0 ? round(Math.abs(debit) / maxProfit) : 0,
            pop: round(100 - stoCall.absDelta * 100),
            theta: round((btoLower.theta - 2 * stoCall.theta + btoUpper.theta) * 100),
            delta: round((btoLower.delta - 2 * stoCall.delta + btoUpper.delta) * 100),
            wings: lowerWing,
            bpe: isCredit ? 0 : debit,
            price_effect: isCredit ? "Credit" : "Debit",
          });
        }
      }
    }
    return results;
  }

  private _buildPutButterflies(
    puts: OptionData[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const stoPut of puts) {
      for (const lowerWing of this.filters.wings) {
        const lowerStrike = exp.strikes.find(
          (s) => Math.abs(s.strikePrice - (stoPut.strikePrice - lowerWing)) < 0.01,
        );
        if (!lowerStrike) continue;
        const btoLower = this._getOptionData(lowerStrike, exp, "Put");
        if (!btoLower || btoLower.midPrice <= 0) continue;

        for (const upperWing of this.filters.wings) {
          const upperStrike = exp.strikes.find(
            (s) => Math.abs(s.strikePrice - (stoPut.strikePrice + upperWing)) < 0.01,
          );
          if (!upperStrike) continue;
          const btoUpper = this._getOptionData(upperStrike, exp, "Put");
          if (!btoUpper || btoUpper.midPrice <= 0) continue;
          if (!this._hasGoodBAS([btoLower, stoPut, btoUpper])) continue;

          const debit = round(btoLower.midPrice - 2 * stoPut.midPrice + btoUpper.midPrice);
          const isCredit = debit < 0;
          if (debit <= 0 && !isCredit) continue;

          const maxProfit = round(lowerWing - debit);
          const name = lowerWing !== upperWing ? "Broken Wing Put Butterfly" : "Put Butterfly";

          results.push({
            strategy_name: name,
            expiry_date: exp.expirationDate,
            dte: exp.daysToExpiration,
            legs: [
              this._leg("BTO", "Put", btoLower),
              { action: "STO", type: "Put", strike: stoPut.strikePrice, price: stoPut.midPrice, delta: round(stoPut.delta), spread: stoPut.bidAskSpread, quantity: 2 },
              this._leg("BTO", "Put", btoUpper),
            ],
            credit: round(-debit),
            max_profit: maxProfit,
            max_loss: isCredit ? 0 : debit,
            rr_ratio: maxProfit > 0 ? round(Math.abs(debit) / maxProfit) : 0,
            pop: round(100 - stoPut.absDelta * 100),
            theta: round((btoLower.theta - 2 * stoPut.theta + btoUpper.theta) * 100),
            delta: round((btoLower.delta - 2 * stoPut.delta + btoUpper.delta) * 100),
            wings: lowerWing,
            bpe: isCredit ? 0 : debit,
            price_effect: isCredit ? "Credit" : "Debit",
          });
        }
      }
    }
    return results;
  }

  // =========================================================================
  // Infrastructure — parsing, filtering, spreads
  // =========================================================================

  private _parseChain(rawChain: any): ParsedExpiration[] {
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

  private _buildOptionDataList(exp: ParsedExpiration, type: "Put" | "Call"): OptionData[] {
    const results: OptionData[] = [];
    for (const strike of exp.strikes) {
      const streamerSym = type === "Put" ? strike.putStreamer : strike.callStreamer;
      const symbol = type === "Put" ? strike.putSymbol : strike.callSymbol;
      const quote = this.tastyClient.getQuote(streamerSym);
      const greeks = this.tastyClient.getGreeks(streamerSym);
      const bidPrice = quote?.bidPrice ?? 0;
      const askPrice = quote?.askPrice ?? 0;
      results.push({
        symbol,
        streamerSymbol: streamerSym,
        strikePrice: strike.strikePrice,
        type,
        expirationDate: exp.expirationDate,
        dte: exp.daysToExpiration,
        bidPrice,
        askPrice,
        midPrice: round((bidPrice + askPrice) / 2),
        delta: greeks?.delta ?? 0,
        absDelta: Math.abs(greeks?.delta ?? 0),
        theta: greeks?.theta ?? 0,
        bidAskSpread: round(askPrice - bidPrice),
      });
    }
    return results.sort((a, b) => b.absDelta - a.absDelta);
  }

  private _getOptionData(
    strike: ParsedStrike,
    exp: ParsedExpiration,
    type: "Put" | "Call",
  ): OptionData | null {
    const streamerSym = type === "Put" ? strike.putStreamer : strike.callStreamer;
    const symbol = type === "Put" ? strike.putSymbol : strike.callSymbol;
    const quote = this.tastyClient.getQuote(streamerSym);
    const greeks = this.tastyClient.getGreeks(streamerSym);
    const bid = quote?.bidPrice ?? 0;
    const ask = quote?.askPrice ?? 0;
    const mid = round((bid + ask) / 2);
    if (mid <= 0) return null;
    return {
      symbol,
      streamerSymbol: streamerSym,
      strikePrice: strike.strikePrice,
      type,
      expirationDate: exp.expirationDate,
      dte: exp.daysToExpiration,
      bidPrice: bid,
      askPrice: ask,
      midPrice: mid,
      delta: greeks?.delta ?? 0,
      absDelta: Math.abs(greeks?.delta ?? 0),
      theta: greeks?.theta ?? 0,
      bidAskSpread: round(ask - bid),
    };
  }

  private _filterByDelta(options: OptionData[], minD: number, maxD: number): OptionData[] {
    return options.filter((o) => o.absDelta >= minD && o.absDelta <= maxD && o.midPrice > 0);
  }

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
        const btoStrike = allStrikes.find((s) => Math.abs(s.strikePrice - targetStrike) < 0.01);
        if (!btoStrike) continue;

        const btoStreamer = type === "put" ? btoStrike.putStreamer : btoStrike.callStreamer;
        const btoSymbol = type === "put" ? btoStrike.putSymbol : btoStrike.callSymbol;
        const btoQuote = this.tastyClient.getQuote(btoStreamer);
        const btoGreeks = this.tastyClient.getGreeks(btoStreamer);
        const btoBid = btoQuote?.bidPrice ?? 0;
        const btoAsk = btoQuote?.askPrice ?? 0;
        const btoMid = round((btoBid + btoAsk) / 2);
        if (btoMid <= 0) continue;

        const stoBAS = stoOption.bidAskSpread;
        const btoBAS = round(btoAsk - btoBid);
        if (stoBAS > this.filters.maxBidAskSpread || btoBAS > this.filters.maxBidAskSpread) continue;
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

  private _calcIronCondorPop(
    ps: CreditSpread,
    cs: CreditSpread,
    totalCredit: number,
    exp: ParsedExpiration,
  ): number {
    const putBE = ps.stoOption.strikePrice - totalCredit;
    const callBE = cs.stoOption.strikePrice + totalCredit;
    const putBEDelta = this._findDeltaAtStrike(exp, putBE, "put");
    const callBEDelta = this._findDeltaAtStrike(exp, callBE, "call");
    return round((1 - (Math.abs(putBEDelta) + Math.abs(callBEDelta))) * 100);
  }

  private _findDeltaAtStrike(exp: ParsedExpiration, target: number, type: "put" | "call"): number {
    let closest: ParsedStrike | null = null;
    let minDiff = Infinity;
    for (const strike of exp.strikes) {
      const diff = type === "put" ? target - strike.strikePrice : strike.strikePrice - target;
      if (diff >= 0 && diff < minDiff) { minDiff = diff; closest = strike; }
    }
    if (!closest) return 0;
    const streamer = type === "put" ? closest.putStreamer : closest.callStreamer;
    return this.tastyClient.getGreeks(streamer)?.delta ?? 0;
  }

  private _hasGoodBAS(options: OptionData[]): boolean {
    return !options.some((o) => o.bidAskSpread < 0 || o.bidAskSpread > this.filters.maxBidAskSpread);
  }

  private _leg(action: "BTO" | "STO", type: "Put" | "Call", opt: OptionData): StrategyLeg {
    return {
      action,
      type,
      strike: opt.strikePrice,
      price: opt.midPrice,
      delta: round(opt.delta),
      spread: opt.bidAskSpread,
    };
  }

  private async _waitForData(sampleSymbols: string[], maxWaitMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (sampleSymbols.some((sym) => this.tastyClient.getQuote(sym) !== undefined)) {
        logger.debug("[StrategyBuilder] Streamer data arrived");
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    logger.warn("[StrategyBuilder] Timed out waiting for streamer data");
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function round(value: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function groupBy<T>(arr: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const key = keyFn(item);
    (result[key] ??= []).push(item);
  }
  return result;
}
