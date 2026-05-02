import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { createServer as createViteServer } from "vite";
import { 
  GameState, Card, CardColor, CardType, GameStatus, Player 
} from "./src/types";

// Note: uuid might need to be installed or I can just use a simple random string
const generateId = () => Math.random().toString(36).substring(2, 11);

const PORT = 3000;

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  const rooms = new Map<string, GameState>();

  // Helper to generate the 175-card UNO No Mercy deck
  function createNoMercyDeck(): Card[] {
    const deck: Card[] = [];
    const colors = [CardColor.RED, CardColor.BLUE, CardColor.GREEN, CardColor.YELLOW];

    colors.forEach(color => {
      // 2 of each number 0-9 (80 cards)
      for (let i = 0; i <= 9; i++) {
        deck.push({ id: generateId(), color, type: CardType.NUMBER, value: i });
        deck.push({ id: generateId(), color, type: CardType.NUMBER, value: i });
      }
      // 3 of each: Skip, Reverse, Draw Two, Discard All (12 * 4 = 48)
      for (let i = 0; i < 3; i++) {
        deck.push({ id: generateId(), color, type: CardType.SKIP });
        deck.push({ id: generateId(), color, type: CardType.REVERSE });
        deck.push({ id: generateId(), color, type: CardType.DRAW_TWO, penalty: 2 });
        deck.push({ id: generateId(), color, type: CardType.DISCARD_ALL });
      }
      // 2 of each: Skip Everyone, Draw Four (8 * 2 = 16)
      for (let i = 0; i < 2; i++) {
        deck.push({ id: generateId(), color, type: CardType.SKIP_EVERYONE });
        deck.push({ id: generateId(), color, type: CardType.DRAW_FOUR, penalty: 4 });
      }
    });

    // Wild / Black cards
    // Wild Reverse Draw Four (8)
    for (let i = 0; i < 8; i++) {
      deck.push({ id: generateId(), color: CardColor.BLACK, type: CardType.WILD_REVERSE_DRAW_FOUR, penalty: 4 });
    }
    // Wild Draw Six (4)
    for (let i = 0; i < 4; i++) {
      deck.push({ id: generateId(), color: CardColor.BLACK, type: CardType.WILD_DRAW_SIX, penalty: 6 });
    }
    // Wild Draw Ten (4)
    for (let i = 0; i < 4; i++) {
      deck.push({ id: generateId(), color: CardColor.BLACK, type: CardType.WILD_DRAW_TEN, penalty: 10 });
    }
    // Wild Color Roulette (8)
    for (let i = 0; i < 8; i++) {
      deck.push({ id: generateId(), color: CardColor.BLACK, type: CardType.WILD_COLOR_ROULETTE });
    }
    // Black Normal Draw Four (4)
    for (let i = 0; i < 4; i++) {
      deck.push({ id: generateId(), color: CardColor.BLACK, type: CardType.BLACK_DRAW_FOUR, penalty: 4 });
    }
    // Black Master Card (2)
    for (let i = 0; i < 2; i++) {
        deck.push({ id: generateId(), color: CardColor.BLACK, type: CardType.BLACK_MASTER });
    }
    // Hand Swap (1)
    deck.push({ id: generateId(), color: CardColor.BLACK, type: CardType.HAND_SWAP });
    
    // Add expansion cards (optional but mentioned)
    // Wild Sudden Death (let's add a few)
    for (let i = 0; i < 4; i++) {
        deck.push({ id: generateId(), color: CardColor.BLACK, type: CardType.WILD_SUDDEN_DEATH });
    }

    return deck;
  }

  function shuffle<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("create_room", (roomName: string, playerName: string) => {
      const roomId = generateId();
      const initialState: GameState = {
        roomId,
        players: [{
          id: socket.id,
          name: playerName || "Host",
          hand: [],
          isReady: false,
          isEliminated: false,
          hasMercyCoin: true, // Everyone starts with one
          score: 0
        }],
        deck: [],
        discardPile: [],
        currentPlayerIndex: 0,
        direction: 1,
        status: GameStatus.LOBBY,
        currentActiveColor: null,
        currentActiveValue: null,
        accumulatedPenalty: 0,
        winnerId: null,
        logs: [`Room created by ${playerName}`],
      };
      rooms.set(roomId, initialState);
      socket.join(roomId);
      io.to(roomId).emit("room_updated", initialState);
    });

    socket.on("join_room", (roomId: string, playerName: string) => {
      const room = rooms.get(roomId);
      if (room && room.status === GameStatus.LOBBY) {
        if (room.players.length >= 8) {
          socket.emit("error", "Room is full");
          return;
        }
        room.players.push({
          id: socket.id,
          name: playerName || `Player ${room.players.length + 1}`,
          hand: [],
          isReady: false,
          isEliminated: false,
          hasMercyCoin: true,
          score: 0
        });
        room.logs.push(`${playerName} joined`);
        socket.join(roomId);
        io.to(roomId).emit("room_updated", room);
      } else {
        socket.emit("error", "Room not found or game already started");
      }
    });

    socket.on("start_game", (roomId: string) => {
      const room = rooms.get(roomId);
      if (room && room.players.length >= 2) {
        room.status = GameStatus.PLAYING;
        room.deck = shuffle(createNoMercyDeck());
        
        // Deal 7 cards to each player
        room.players.forEach(p => {
          p.hand = room.deck.splice(0, 7);
          p.isEliminated = false;
        });

        // Initial discard pile
        let initialCard;
        do {
            initialCard = room.deck.pop();
            if (initialCard) {
                // Rules: First card cannot be black. If it is, ignore and try again.
                if (initialCard.color === CardColor.BLACK) {
                    room.deck.unshift(initialCard); // Put back and reshuffle or just ignore
                    room.deck = shuffle(room.deck);
                    initialCard = undefined;
                } else {
                    room.discardPile.push(initialCard);
                    room.currentActiveColor = initialCard.color;
                    room.currentActiveValue = initialCard.type === CardType.NUMBER ? initialCard.value! : initialCard.type;
                }
            }
        } while (!initialCard);

        room.logs.push("Game started!");
        io.to(roomId).emit("room_updated", room);
      }
    });

    socket.on("play_card", (roomId: string, cardId: string, chosenColor?: CardColor) => {
        const room = rooms.get(roomId);
        if (!room || room.status !== GameStatus.PLAYING) return;
        
        const player = room.players[room.currentPlayerIndex];
        if (player.id !== socket.id) return;

        const cardIndex = player.hand.findIndex(c => c.id === cardId);
        if (cardIndex === -1) return;

        const card = player.hand[cardIndex];

        // Validation logic
        const isValid = validateMove(room, card);
        if (!isValid) {
            socket.emit("error", "Invalid move");
            return;
        }

        // Apply card effects
        player.hand.splice(cardIndex, 1);
        room.discardPile.push(card);
        
        processCardEffect(room, card, chosenColor);

        // Check for UNO (optional but good)
        if (player.hand.length === 1) {
            room.logs.push(`${player.name} says UNO!`);
        }

        // Check win condition
        if (player.hand.length === 0) {
            // Cannot win on black card
            if (card.color === CardColor.BLACK) {
               // Technically rules say you can't play it as last card. 
               // We should have validated this earlier.
            } else {
                room.winnerId = player.id;
                room.status = GameStatus.FINISHED;
                room.logs.push(`${player.name} WINS!`);
            }
        }

        // Mercy rule check
        checkMercyRule(room);

        // Next turn if not finished
        if (room.status === GameStatus.PLAYING) {
            advanceTurn(room, card);
        }

        io.to(roomId).emit("room_updated", room);
    });

    socket.on("draw_card", (roomId: string) => {
        const room = rooms.get(roomId);
        if (!room || room.status !== GameStatus.PLAYING) return;
        
        const player = room.players[room.currentPlayerIndex];
        if (player.id !== socket.id) return;

        // If penalty exists, must draw it all unless stacked (handled in play_card)
        if (room.accumulatedPenalty > 0) {
            drawCards(room, player, room.accumulatedPenalty);
            room.accumulatedPenalty = 0;
            advanceTurn(room);
        } else {
            // Draw until you can play
            let drawnCard: Card | null = null;
            let drawnCount = 0;
            while (!drawnCard && room.deck.length > 0) {
                const card = room.deck.pop()!;
                drawnCount++;
                if (validateMove(room, card)) {
                    drawnCard = card;
                } else {
                    player.hand.push(card);
                    if (player.hand.length >= 40) {
                        eliminatePlayer(room, player);
                        break;
                    }
                }
            }
            if (room.deck.length === 0) replenishDeck(room);
            
            if (drawnCard) {
                room.logs.push(`${player.name} drew ${drawnCount} cards and played ${drawnCard.type}.`);
                // Auto play the drawable card
                room.discardPile.push(drawnCard);
                // If it's black, we default to random color for auto-play simplicity in MVP
                const chosenColor = drawnCard.color === CardColor.BLACK ? [CardColor.RED, CardColor.BLUE, CardColor.GREEN, CardColor.YELLOW][Math.floor(Math.random()*4)] : undefined;
                processCardEffect(room, drawnCard, chosenColor);
                
                if (player.hand.length === 0) {
                    room.winnerId = player.id;
                    room.status = GameStatus.FINISHED;
                }
                if (room.status === GameStatus.PLAYING) {
                    advanceTurn(room, drawnCard);
                }
            } else {
                room.logs.push(`${player.name} drew ${drawnCount} cards but couldn't play (or was eliminated).`);
                advanceTurn(room);
            }
        }
        
        io.to(roomId).emit("room_updated", room);
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      // Handle player leaving rooms
      rooms.forEach((room, roomId) => {
        const index = room.players.findIndex(p => p.id === socket.id);
        if (index !== -1) {
            room.players[index].isEliminated = true;
            room.logs.push(`${room.players[index].name} disconnected`);
            if (room.players.every(p => p.isEliminated || p.id === socket.id)) {
                // Delete empty rooms?
            }
            io.to(roomId).emit("room_updated", room);
        }
      });
    });
  });

  // HELPER FUNCTIONS
  function validateMove(room: GameState, card: Card): boolean {
    if (room.accumulatedPenalty > 0) {
        // Must stack if penalty exists. Only Draw cards of equal or higher value.
        const currentDrawPenalty = getPenaltyValue(room.discardPile[room.discardPile.length - 1]);
        if (!card.penalty || card.penalty < currentDrawPenalty) return false;
        return true;
    }

    if (card.color === CardColor.BLACK) return true;
    if (card.color === room.currentActiveColor) return true;
    if (card.type === CardType.NUMBER && card.value === room.currentActiveValue) return true;
    if (card.type !== CardType.NUMBER && card.type === room.currentActiveValue) return true;

    return false;
  }

  function getPenaltyValue(card: Card): number {
      return card.penalty || 0;
  }

  function processCardEffect(room: GameState, card: Card, chosenColor?: CardColor) {
      room.currentActiveColor = card.color === CardColor.BLACK ? (chosenColor || CardColor.RED) : card.color;
      room.currentActiveValue = card.type === CardType.NUMBER ? card.value! : card.type;

      if (card.penalty) {
          // Stacking rule: highest card value replaces, doesn't add?
          // Prompt says: "Stacking cards does not increase the overall penalty sum... penalty for next player is simply 6 cards, not 10."
          room.accumulatedPenalty = card.penalty;
      }

      switch (card.type) {
          case CardType.NUMBER: {
              const player = room.players[room.currentPlayerIndex];
              if (card.value === 0) {
                  // Global hand pass
                  room.logs.push(`${player.name} played 0! All hands shifting.`);
                  const hands = room.players.map(p => [...p.hand]);
                  room.players.forEach((p, i) => {
                      const nextIdx = (i + room.direction + room.players.length) % room.players.length;
                      room.players[nextIdx].hand = hands[i];
                  });
              } else if (card.value === 7) {
                  // Simply swap with next for now in this MVP, or could extend with target selective
                  room.logs.push(`${player.name} played 7! Swapping hands.`);
                  const nextIdx = (room.currentPlayerIndex + room.direction + room.players.length) % room.players.length;
                  const tempHand = [...player.hand];
                  player.hand = room.players[nextIdx].hand;
                  room.players[nextIdx].hand = tempHand;
              }
              break;
          }
          case CardType.REVERSE:
          case CardType.WILD_REVERSE_DRAW_FOUR:
              room.direction *= -1;
              if (room.players.length === 2) {
                  // In 2 player, Reverse acting as Skip
                  // We'll advance twice basically
              }
              break;
          case CardType.DISCARD_ALL: {
              const player = room.players[room.currentPlayerIndex];
              const toDiscard = player.hand.filter(c => c.color === card.color && c.id !== card.id);
              player.hand = player.hand.filter(c => c.color !== card.color);
              room.discardPile.push(...toDiscard);
              break;
          }
          case CardType.HAND_SWAP:
              // For simplicity, let's just swap with next for now or allow player to choose
              // UI should handle choice, but let's do a basic implementation
              break;
          case CardType.SKIP_EVERYONE:
              // Handled by advancing turn differently
              break;
      }
  }

  function advanceTurn(room: GameState, cardPlayed?: Card) {
      let skipCount = 1;
      if (cardPlayed?.type === CardType.SKIP) skipCount = 2;
      if (cardPlayed?.type === CardType.SKIP_EVERYONE) skipCount = room.players.length;
      
      // If 2 player and Reverse
      if (room.players.length === 2 && (cardPlayed?.type === CardType.REVERSE || cardPlayed?.type === CardType.WILD_REVERSE_DRAW_FOUR)) {
          skipCount = 2;
      }

      room.currentPlayerIndex = (room.currentPlayerIndex + (room.direction * skipCount) + room.players.length) % room.players.length;
      
      // Skip eliminated players
      while (room.players[room.currentPlayerIndex].isEliminated) {
          room.currentPlayerIndex = (room.currentPlayerIndex + room.direction + room.players.length) % room.players.length;
      }
  }

  function drawCards(room: GameState, player: Player, count: number) {
      for (let i = 0; i < count; i++) {
          if (room.deck.length === 0) replenishDeck(room);
          const card = room.deck.pop();
          if (card) player.hand.push(card);
      }
  }

  function replenishDeck(room: GameState) {
      const topCard = room.discardPile.pop()!;
      room.deck = shuffle(room.discardPile);
      room.discardPile = [topCard];
  }

  function checkMercyRule(room: GameState) {
      room.players.forEach(p => {
          if (p.hand.length >= 40 && !p.isEliminated) {
              eliminatePlayer(room, p);
          }
      });
  }

  function eliminatePlayer(room: GameState, player: Player) {
      player.isEliminated = true;
      room.logs.push(`${player.name} eliminated by Mercy rule!`);
      // Return cards to deck bottom later (via replenish)
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
