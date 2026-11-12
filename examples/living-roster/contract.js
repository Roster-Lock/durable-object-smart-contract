/**
 * Living Roster - an example contract.
 *
 * A roster is a shared list of pieces. Pieces move on and off it through four
 * forces, all of which are just endpoints here:
 *
 *   - democracy:  propose() + vote() + resolve()
 *   - ranking:    setWeight() feeds each voter's weight from matchmaking
 *   - money:      the platform already charges gas per call; setWeight() can
 *                 also be driven by a paid subscription or stake
 *   - dictator:   dictate() lets the owner overrule the vote
 *
 * Weights are never supplied by the voter. They are stored by the owner (or,
 * in production, by a trusted ranking/payments job) so a voter cannot vote
 * with a weight they did not earn.
 *
 * The storage block is the contract's schema: collections are declared up
 * front, nested maps are real handles (`await votes.get(id)`), and every
 * write is checked against the declared JSON Schema.
 *
 * This file is plain JavaScript run inside QuickJS. It is a deploy-time
 * artefact, not part of the build.
 */

var CONFIG_SCHEMA = {
  type: "object",
  required: ["quorum", "approval", "rosterLimit"],
  properties: {
    quorum: { type: "integer", minimum: 1 },
    approval: { type: "number", exclusiveMinimum: 0, maximum: 1 },
    rosterLimit: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
};

var PROPOSAL_SCHEMA = {
  type: "object",
  required: ["id", "action", "pieceId", "proposer", "yes", "no", "resolved"],
  properties: {
    id: { type: "string" },
    action: { enum: ["add", "remove"] },
    pieceId: { type: "string" },
    proposer: { type: "string" },
    yes: { type: "integer", minimum: 0 },
    no: { type: "integer", minimum: 0 },
    resolved: { type: "boolean" },
    outcome: { enum: ["approved"] },
  },
  additionalProperties: false,
};

var VOTE_SCHEMA = {
  type: "object",
  required: ["support", "weight"],
  properties: {
    support: { type: "boolean" },
    weight: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
};

var SET_WEIGHT_INPUT = {
  type: "object",
  required: ["userId", "weight"],
  properties: {
    userId: { type: "string" },
    weight: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
};

var PROPOSE_INPUT = {
  type: "object",
  required: ["proposalId", "action", "pieceId"],
  properties: {
    proposalId: { type: "string" },
    action: { enum: ["add", "remove"] },
    pieceId: { type: "string" },
  },
  additionalProperties: false,
};

var VOTE_INPUT = {
  type: "object",
  required: ["proposalId", "support"],
  properties: {
    proposalId: { type: "string" },
    support: { type: "boolean" },
  },
  additionalProperties: false,
};

var RESOLVE_INPUT = {
  type: "object",
  required: ["proposalId"],
  properties: { proposalId: { type: "string" } },
  additionalProperties: false,
};

var PROPOSAL_INPUT = {
  type: "object",
  required: ["proposalId"],
  properties: { proposalId: { type: "string" } },
  additionalProperties: false,
};

// Schema-driven client example. The roster endpoint is a fetchable source:
// it is public, read-only and takes no arguments. `x-roster-list` tells the
// generated client to offer only pieces that are currently on the roster.
var ROSTER_PIECE_INPUT = {
  type: "object",
  title: "Inspect a roster piece",
  description: "Choose a piece that is currently on the roster.",
  required: ["pieceId"],
  properties: {
    pieceId: {
      type: "string",
      title: "Piece",
      "x-roster-list": {
        type: "piece",
        include: [{ handle: "living-roster", endpoint: "roster" }],
      },
    },
  },
  additionalProperties: false,
};

var DICTATE_INPUT = {
  type: "object",
  required: ["action", "pieceId"],
  properties: {
    action: { enum: ["add", "remove"] },
    pieceId: { type: "string" },
  },
  additionalProperties: false,
};

var PROPOSAL_CREATED_EVENT = {
  type: "object",
  required: ["proposalId", "action", "pieceId", "proposer"],
  properties: {
    proposalId: { type: "string" },
    action: { enum: ["add", "remove"] },
    pieceId: { type: "string" },
    proposer: { type: "string" },
  },
  additionalProperties: false,
};

var VOTE_CAST_EVENT = {
  type: "object",
  required: ["proposalId", "voter", "support", "weight"],
  properties: {
    proposalId: { type: "string" },
    voter: { type: "string" },
    support: { type: "boolean" },
    weight: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
};

var PROPOSAL_RESOLVED_EVENT = {
  type: "object",
  required: ["proposalId", "action", "pieceId", "outcome"],
  properties: {
    proposalId: { type: "string" },
    action: { enum: ["add", "remove"] },
    pieceId: { type: "string" },
    outcome: { type: "string" },
  },
  additionalProperties: false,
};

var PIECE_CHANGED_EVENT = {
  type: "object",
  required: ["action", "pieceId", "by", "dictated"],
  properties: {
    action: { enum: ["add", "remove"] },
    pieceId: { type: "string" },
    by: { type: "string" },
    dictated: { type: "boolean" },
  },
  additionalProperties: false,
};

async function requireOwner(ctx) {
  var owner = await ctx.storage.owner.get();
  if (!owner || owner !== ctx.msgSender.id) {
    throw new Error("owner only");
  }
}

async function loadConfig(ctx) {
  return (
    (await ctx.storage.config.get()) || {
      quorum: 3,
      approval: 0.6,
      rosterLimit: 32,
    }
  );
}

async function readRoster(ctx) {
  return await ctx.storage.roster.slice(0, 1000);
}

async function applyAction(ctx, action, pieceId, config) {
  var roster = ctx.storage.roster;
  var pieces = await readRoster(ctx);
  var index = pieces.indexOf(pieceId);

  if (action === "add") {
    if (index !== -1) throw new Error("piece is already on the roster");
    if (pieces.length >= config.rosterLimit) throw new Error("the roster is full");
    await roster.addToTop([pieceId]);
    return;
  }
  if (action === "remove") {
    if (index === -1) throw new Error("piece is not on the roster");
    await roster.removeAt(index, 1);
    return;
  }
  throw new Error('action must be "add" or "remove"');
}

function requireInteger(value, label, min) {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(label + " must be an integer of at least " + min);
  }
  return value;
}

defineContract({
  name: "living-roster",
  version: "2.0.0",
  events: {
    ProposalCreated: { schema: PROPOSAL_CREATED_EVENT },
    VoteCast: { schema: VOTE_CAST_EVENT },
    ProposalResolved: { schema: PROPOSAL_RESOLVED_EVENT },
    PieceChanged: { schema: PIECE_CHANGED_EVENT },
  },

  storage: {
    owner: { kind: "value", schema: { type: "string" } },

    config: { kind: "value", schema: CONFIG_SCHEMA },
    weights: {
      kind: "map",
      key: { type: "string" },
      value: { kind: "value", schema: { type: "integer", minimum: 0 } },
    },
    proposals: {
      kind: "map",
      key: { type: "string" },
      value: { kind: "value", schema: PROPOSAL_SCHEMA },
    },
    votes: {
      kind: "map",
      key: { type: "string" },
      value: {
        kind: "map",
        key: { type: "string" },
        value: { kind: "value", schema: VOTE_SCHEMA },
      },
    },
    roster: {
      kind: "array",
      maxItems: 64,
      item: { type: "string", minLength: 1 },
    },
  },

  // Runs once, inside the first deploy's transaction. A redeploy does not
  // re-run it, so the roster's rules survive an upgrade.
  init: async function (ctx) {
    // Remember who deployed the contract. Ownership is application data, not a
    // platform access mode, so it can be transferred later by an endpoint.
    await ctx.storage.owner.set(ctx.msgSender.id);
    await ctx.storage.config.set({
      quorum: 3,
      approval: 0.6,
      rosterLimit: 32,
    });
  },

  endpoints: {
    // The owner configures the rules. The "dictator" role is the id stored at
    // init, not a platform access mode; an ownership transfer just changes it.
    configure: {
      access: "human",
      input: CONFIG_SCHEMA,
      run: async function (input, ctx) {
        await requireOwner(ctx);
        var next = {
          quorum: requireInteger(input.quorum, "quorum", 1),
          approval: input.approval,
          rosterLimit: requireInteger(input.rosterLimit, "rosterLimit", 1),
        };
        if (!(next.approval > 0 && next.approval <= 1)) {
          throw new Error("approval must be in (0, 1]");
        }
        await ctx.storage.config.set(next);
        return next;
      },
    },

    // Ranking / money oracle. In production this is written by the
    // matchmaking service and the payment webhook, not by the owner.
    setWeight: {
      access: "human",
      input: SET_WEIGHT_INPUT,
      run: async function (input, ctx) {
        await requireOwner(ctx);
        var weight = requireInteger(input.weight, "weight", 0);
        await ctx.storage.weights.set(String(input.userId), weight);
        return { userId: input.userId, weight: weight };
      },
    },

    propose: {
      input: PROPOSE_INPUT,
      run: async function (input, ctx) {
        var proposals = ctx.storage.proposals;
        var id = String(input.proposalId);
        if (await proposals.has(id)) throw new Error("proposal already exists");
        if (input.action !== "add" && input.action !== "remove") {
          throw new Error('action must be "add" or "remove"');
        }
        if (typeof input.pieceId !== "string" || input.pieceId.length === 0) {
          throw new Error("pieceId is required");
        }
        var proposal = {
          id: id,
          action: input.action,
          pieceId: input.pieceId,
          proposer: ctx.msgSender.id,
          yes: 0,
          no: 0,
          resolved: false,
        };
        await proposals.set(id, proposal);
        await ctx.emit("ProposalCreated", {
          proposalId: id,
          action: input.action,
          pieceId: input.pieceId,
          proposer: ctx.msgSender.id,
        });
        return proposal;
      },
    },

    vote: {
      input: VOTE_INPUT,
      run: async function (input, ctx) {
        if (typeof input.support !== "boolean") {
          throw new Error("support must be a boolean");
        }
        var id = String(input.proposalId);
        var proposals = ctx.storage.proposals;
        var proposal = await proposals.get(id);
        if (proposal === undefined) throw new Error("unknown proposal");
        if (proposal.resolved) throw new Error("proposal is already resolved");

        var votes = await ctx.storage.votes.get(id);
        if (await votes.has(ctx.msgSender.id)) throw new Error("already voted on this proposal");

        var stored = await ctx.storage.weights.get(ctx.msgSender.id);
        var weight = stored === undefined ? 1 : stored;
        await votes.set(ctx.msgSender.id, { support: input.support, weight: weight });
        await ctx.emit("VoteCast", {
          proposalId: id,
          voter: ctx.msgSender.id,
          support: input.support,
          weight: weight,
        });

        if (input.support) {
          proposal.yes += weight;
        } else {
          proposal.no += weight;
        }
        await proposals.set(id, proposal);
        return proposal;
      },
    },

    resolve: {
      input: RESOLVE_INPUT,
      run: async function (input, ctx) {
        var id = String(input.proposalId);
        var proposals = ctx.storage.proposals;
        var proposal = await proposals.get(id);
        if (proposal === undefined) throw new Error("unknown proposal");
        if (proposal.resolved) throw new Error("proposal is already resolved");

        var config = await loadConfig(ctx);
        var total = proposal.yes + proposal.no;
        if (total < config.quorum) throw new Error("quorum not reached");
        if (proposal.yes / total < config.approval) {
          throw new Error("the vote did not reach the approval threshold");
        }

        await applyAction(ctx, proposal.action, proposal.pieceId, config);
        proposal.resolved = true;
        proposal.outcome = "approved";
        await proposals.set(id, proposal);
        await ctx.emit("ProposalResolved", {
          proposalId: id,
          action: proposal.action,
          pieceId: proposal.pieceId,
          outcome: "approved",
        });
        return proposal;
      },
    },

    // Read-only source for x-roster-list. It must declare mutates:false so a
    // generated client can fetch it without treating it as a transaction.
    inspectPiece: {
      access: "public",
      mutates: false,
      input: ROSTER_PIECE_INPUT,
      run: async function (input, ctx) {
        var roster = await readRoster(ctx);
        var pieceId = String(input.pieceId);
        return { pieceId: pieceId, onRoster: roster.indexOf(pieceId) !== -1 };
      },
    },

    // The fallback: the owner can move a piece without a vote. Every action is
    // still a public, logged, gas-metered call.
    dictate: {
      access: "human",
      input: DICTATE_INPUT,
      run: async function (input, ctx) {
        await requireOwner(ctx);
        var config = await loadConfig(ctx);
        await applyAction(ctx, input.action, input.pieceId, config);
        await ctx.emit("PieceChanged", {
          action: input.action,
          pieceId: input.pieceId,
          by: ctx.msgSender.id,
          dictated: true,
        });
        return await readRoster(ctx);
      },
    },

    roster: {
      access: "public",
      mutates: false,
      run: async function (_input, ctx) {
        return await readRoster(ctx);
      },
    },

    proposal: {
      input: PROPOSAL_INPUT,
      run: async function (input, ctx) {
        var proposal = await ctx.storage.proposals.get(String(input.proposalId));
        if (proposal === undefined) throw new Error("unknown proposal");
        return proposal;
      },
    },
  },
});
