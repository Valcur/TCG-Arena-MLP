import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SECTIONS, defaultSections } from "./PlayerSection/GameBoard";
import { useGameContext } from "../Commons/GameContext";
import { setPositions } from "../Commons/Functions";
import Card from "./Card/Card";
import CardQuickActions from "./Card/CardQuickActions";
import { sendTwitchData } from "../Home/Preferences/Twitch/TwitchHandler";
import { CardsUpdateStore } from "./Others/CardsUpdateStore/CardsUpdateStore";

export default function VisibleCards({
    allVisibleCardsRef,
    gameOptions,
    repositionCardsForPlayerRef,
    cardsByPlayerAndSectionRef,
    playerLayout,
    players,
    allReady,
    sections,
    reposition,
    cardTappedRotation,

    cardDraggedRef,
    clickCard,
    deckRef,
    cards,
    setCurrentActionMode,
    setFocusedCard,
    opponentIds,
    opponentsData,
    giveCardTo,
    moveCard,
    createToken,
    currentActionMode,
    sendToHistory,
    playerId,
    setIsTextInputFocused,
    sectionsData,
    refreshCount,
    playerSleeves,
    multiSelection,
    setMultiSelection,
    enqueueSound,
    addToStepHistory,
    sendCardZonesOrder,
    isHost,
    cardActionsRef,
    setCardMenuData,
    showHiddenCardsToSpecs,
    isSpectating
}) {
    const { cardSize, preferences, loginData, gameData } = useGameContext()
    const sectionsRectRef = useRef({ COMMONS: {} })
    const playerBoardElementsRef = useRef(new Map())
    const [sizeHasChanged, setSizeHasChanged] = useState(false);

   /* useEffect(() => {
        if (gameOptions) {
            setTimeout(() => {
                updateSectionsClientRect()
                repositionCards()
            }, 100)
        }
    }, [sections, gameOptions])*/

    useEffect(() => {
        if (!sizeHasChanged) return;

        updateSectionsClientRect();
        repositionCards();

        setSizeHasChanged(false);
    }, [sizeHasChanged]);

    useEffect(() => {
        let timeout;

        const handleResize = () => {
            clearTimeout(timeout);

            timeout = setTimeout(() => {
                setSizeHasChanged(true);
            }, 100);
        };

        window.addEventListener("resize", handleResize);

        return () => {
            clearTimeout(timeout);
            window.removeEventListener("resize", handleResize);
        };
    }, []);

    function updateSectionsClientRect(localOnly = true) {
        if (!sections?.sectionsArray) return
        sectionsRectRef.current = {
            "COMMONS": {}
        };

        players.forEach(id => {
            const playerBoard = document.getElementById('board-' + id);
            if (playerBoard) {
                playerBoardElementsRef.current.set(id, playerBoard)

                if (!sectionsRectRef.current[id]) {
                    sectionsRectRef.current[id] = {}
                }

                sections.sectionsArray.forEach((s, i) => {
                    if (s.type === SECTIONS.TYPES.custom) return
                    if (sections.commonSectionTitles.includes(s.title)) return
                    let sectionKey = '#section-' + s.title
                    if ([SECTIONS.EXILE, SECTIONS.EXILE_HIDDEN, SECTIONS.SIDEBOARD].includes(s.title)) {
                        sectionKey = '#section-' + SECTIONS.DISCARD
                    }

                    const element = playerBoard.querySelector(sectionKey);

                    if (element) {
                        const rect = element.getBoundingClientRect();
                        sectionsRectRef.current[id][s.title] = rect
                    } else {
                        //console.warn(s.title + " id not found for player " + id)
                    }
                })
            }
        })

        sections?.commonSectionTitles.forEach(s => {
            const sectionKey = 'section-' + s
            const element = document.getElementById(sectionKey);

            if (element) {
                const rect = element.getBoundingClientRect();
                sectionsRectRef.current["COMMONS"][s] = rect
            } else {
                //console.warn(s + " id not found for common section")
            }
        })
    }

    const optionalSectionsCounts = players
        .map((pId) => opponentsData[pId]?.optionalBoardSections?._count)
        .join(",");

    useEffect(() => {
        updateSectionsClientRect();
        repositionCards();
    }, [playerLayout, optionalSectionsCounts, sections]);

    useEffect(() => {
        repositionCards()
    }, [cardTappedRotation])
    /*
        useEffect(() => {
            updateSectionsClientRect(false)
        }, [optionalBoardSections])*/

    const [visibleCards, setVisibleCards] = useState([])

    // Permettre de modiifer les crates que d'un joueur précis, repositon pas les autres (si pas groupé à une des cartes de ce joueur)
    const repositionCards = useCallback((changedSections, localOnly) => {
        if (!allVisibleCardsRef || !playerLayout.playerBoardScale || !sections) return;

        const allSections = sections.sectionsArray
        const sectionsRect = sectionsRectRef.current

        const sectionsCards = {};
        const grouppedCards = {
            byId: {},
            byParentId: {},
            ungroupped: []
        }

        const addCardToSectionCards = (c) => {
            const pos = c.position.section
            const key = sections.commonSectionTitles.includes(pos) ? pos : pos + "-" + c.position.playerSide
            if (pos && !sectionsCards[key]) {
                sectionsCards[key] = []
            }
            sectionsCards[key].push(c);
            // A voir sectionsCards[key].push({ card: c, index: i });
        }

        const allCardsFlat = [];
        const seenCards = new Map(); // id -> { card, slotKey }

        const considerCard = (card, slotKey) => {
            const existing = seenCards.get(card.id);
            if (!existing) {
                seenCards.set(card.id, { card, slotKey });
                return;
            }

            const existingTakenAt = existing.card._takenAt;
            const newTakenAt = card._takenAt;

            let keepNew;
            if (newTakenAt !== undefined && existingTakenAt !== undefined && newTakenAt !== existingTakenAt) {
                // Les deux copies ont un _takenAt distinct -> la plus récente gagne
                keepNew = newTakenAt > existingTakenAt;
            } else {
                // Pas de _takenAt exploitable (absent d'un côté, ou identique) ->
                // on privilégie la copie qui vit dans mon propre emplacement de la Map
                const existingIsMine = existing.slotKey === playerId;
                const newIsMine = slotKey === playerId;
                keepNew = newIsMine && !existingIsMine;
            }

            console.warn(
                "Doublon filtré avant rendu:", card.id,
                keepNew ? `gardé sous ${slotKey} (nouveau)` : `gardé sous ${existing.slotKey} (existant)`,
                "ignoré:", keepNew ? existing.slotKey : slotKey, existing.card, "vs", card
            );
            console.log("sources JSON:", JSON.stringify(Object.fromEntries(allVisibleCardsRef.current)));

            if (keepNew) {
                seenCards.set(card.id, { card, slotKey });
            }
        };

        for (let i = 0; i < players.length; i++) {
            const playerCards = allVisibleCardsRef.current.get(players[i]);
            if (playerCards) {
                for (let j = 0; j < playerCards.length; j++) {
                    considerCard(playerCards[j], players[i]);
                }
            }
        }

        const unownedCards = allVisibleCardsRef.current.get("UNOWNED");
        if (unownedCards) {
            for (let j = 0; j < unownedCards.length; j++) {
                considerCard(unownedCards[j], "UNOWNED");
            }
        }

        for (const { card } of seenCards.values()) {
            allCardsFlat.push(card);
        }

        for (let i = 0; i < allCardsFlat.length; i++) {
            const c = allCardsFlat[i];
            if (c.position.section) {
                addCardToSectionCards(c);
                if (c.removeGrouppedCards) {
                    grouppedCards.ungroupped.push(c);
                }
            } else {
                const parentId = c.grouppedToId;
                if (!grouppedCards.byParentId[parentId]) {
                    grouppedCards.byParentId[parentId] = [];
                }
                grouppedCards.byParentId[parentId].push(c.id);
                grouppedCards.byId[c.id] = c;
            }
        }

        // If removed from parent, position = parent section or stack if not in my side
        grouppedCards.ungroupped.forEach(parent => {
            const parentId = parent.id
            const childrens = grouppedCards.byParentId[parentId]
            childrens?.forEach(childId => {
                const child = grouppedCards.byId[childId]
                if (!child) return
                if (child.owner !== child.position.playerSide) {
                    child.position.section = SECTIONS.STACK
                    child.position.index = 9999
                    child.position.playerSide = child.owner
                } else {
                    child.position.section = parent.removeGrouppedCards
                    child.position.playerSide = child.owner
                }
                addCardToSectionCards(child)
                delete child.grouppedToId
                delete grouppedCards.byId[child.id]
            })
            delete parent.removeGrouppedCards
            delete grouppedCards.byParentId[parentId]
        })

        const handleSectionReposition = (s, p, isCommonSection) => {
            const side = isCommonSection ? "COMMONS" : p;
            const scale = isCommonSection ? 1 : playerLayout.playerBoardScale[side];
            const key = isCommonSection ? s.title : s.title + "-" + p;
            if (!sectionsRect[side]) return
            setPositions(
                sectionsCards[key] ?? [],
                sectionsRect[side][s.title],
                s,
                cardSize.vh * scale,
                // old opp side !== playerId,
                !isCommonSection && playerLayout.placement.placementMap[p] === "top",
                cardTappedRotation === "90",
                grouppedCards,
                playerLayout
            );
        }

        const officialZonesOrder = {};
        cardsByPlayerAndSectionRef.current = {}
        players.forEach((p, i) => {
            allSections.forEach((s) => {
                const isCommonSection = sections.commonSectionTitles.includes(s.title)
                // if spec, we reposition common sections for player 0‡
                if (
                    !isCommonSection ||
                    p === playerId ||
                    (isSpectating && i === 0)
                ) {
                    handleSectionReposition(s, p, isCommonSection);
                }

                const sectionKey = isCommonSection ? s.title : s.title + "-" + p;
                const sectionCards = sectionsCards[sectionKey];

                if (!cardsByPlayerAndSectionRef.current[p]) {
                    cardsByPlayerAndSectionRef.current[p] = {}
                }
                cardsByPlayerAndSectionRef.current[p][s.title] = sectionCards

                if (isHost && isCommonSection && Array.isArray(sectionCards)) {
                    officialZonesOrder[sectionKey] = sectionCards.map(card => card.id);
                }
            });
        })

        if (isHost) {
            //setTimeout(() => {
            sendCardZonesOrder(officialZonesOrder)
            //}, 200)

        }

        allCardsFlat.sort((a, b) => (a.id < b.id ? -1 : 1));
        setVisibleCards(allCardsFlat)
        const twitchPref = preferences?.twitch
        if (twitchPref?.isEnabled && loginData?.isSupporter) {
            sendTwitchData(gameData.name, allCardsFlat, playerLayout.placement.placementMap, cardTappedRotation, twitchPref.calibration, sections?.sectionsDict, { playerId: playerId, isSpectating: isSpectating, showHiddenCardsToSpecs: showHiddenCardsToSpecs })
        }

        CardsUpdateStore.notify()
        //setDeck(playerDeckRef.current)
    }, [
        playerId,
        playerLayout,
        players,
        sections,
        isHost,
        cardTappedRotation,
        cardSize,
        preferences,
        loginData,
        gameData,
        isSpectating,
        showHiddenCardsToSpecs
    ]);

    useEffect(() => {
        repositionCardsForPlayerRef.current = repositionCards
    }, [repositionCards])

    return (
        <div className="visible-cards position-fixed top-0 start-0 w-100 h-100 pe-none" style={{ zIndex: 100 }}>
            {visibleCards.map((c, i) => {
                return (<Card
                    key={c.id}
                    card={c}
                    cardDraggedRef={cardDraggedRef}

                    setCardMenuData={setCardMenuData}

                    cardActionsRef={cardActionsRef}

                    deckRef={deckRef}
                    cards={cards}
                    setCurrentActionMode={setCurrentActionMode}
                    setFocusedCard={setFocusedCard}
                    opponentIds={opponentIds}


                    currentActionMode={currentActionMode}
                    sendToHistory={sendToHistory}
                    playerId={playerId}
                    setIsTextInputFocused={setIsTextInputFocused}
                    gameOptions={gameOptions}
                    sectionsData={sectionsData}
                    handSize={c.position.section === SECTIONS.HAND ? cardsByPlayerAndSectionRef.current[c.position.playerSide]?.[SECTIONS.HAND]?.length ?? 0 : 0}
                    refreshCount={refreshCount}
                    playerSleeves={playerSleeves}
                    multiSelection={multiSelection}
                    setMultiSelection={setMultiSelection}
                    enqueueSound={enqueueSound}
                    addToStepHistory={addToStepHistory}
                    isOpponentCard={c.owner !== playerId && c.owner !== "UNOWNED"}
                    allReady={allReady}
                    placementSide={playerLayout?.placement?.placementMap?.[c?.position?.playerSide] ?? "bottom"}
                    isMinimised={playerLayout.playerBoardScale?.[c?.position?.playerSide] === 0.2}
                    showHiddenCardsToSpecs={showHiddenCardsToSpecs}
                    isSpectating={isSpectating}
                />)
            }
            )}
        </div>
    )
}