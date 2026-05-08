import { useEffect, useMemo, useState } from 'react'
import GoalViewer from './section/goal-view'
import {
        createMockGoalListFromTemplate,
        findGoalById,
        getGoalChildren,
        getRootGoals,
        type Goal,
} from './goal'
import { buildGoalPath, getLocationState, ROOT_GOAL_ID, type RouteName } from './config/utils';

function App() {
        const initialLocation = getLocationState()
        const mockGoals = useMemo(() => createMockGoalListFromTemplate(), [])
        const [route, setRoute] = useState<RouteName>(initialLocation.route)
        const [goalId, setGoalId] = useState<string | null>(initialLocation.goalId)
        const [message, setMessage] = useState(
                `Using mock goals only. Loaded ${mockGoals.length} items locally.`,
        )

        const selectedParentGoal = useMemo<Goal | null>(() => {
                if (!goalId || goalId === ROOT_GOAL_ID) {
                        return null
                }

                return findGoalById(mockGoals, goalId)
        }, [goalId, mockGoals])

        const visibleGoals = useMemo(() => {
                if (!goalId || goalId === ROOT_GOAL_ID) {
                        return getRootGoals(mockGoals)
                }

                if (!selectedParentGoal) {
                        return []
                }

                return getGoalChildren(mockGoals, selectedParentGoal.globalIndex)
        }, [goalId, mockGoals, selectedParentGoal])

        useEffect(() => {
                const onPopState = () => {
                        const locationState = getLocationState()
                        setRoute(locationState.route)
                        setGoalId(locationState.goalId)
                }

                window.addEventListener('popstate', onPopState)
                return () => window.removeEventListener('popstate', onPopState)
        }, [])

        function viewRootGoal() {
                if (mockGoals.length === 0) {
                        setMessage('No mock goals are available.')
                        return
                }

                setMessage('Viewing root mock goals.')
                setGoalId(ROOT_GOAL_ID)
                window.history.pushState({}, '', buildGoalPath(ROOT_GOAL_ID))
                setRoute('goal')
        }

        if (route === 'goal') {
                if (mockGoals.length === 0) {
                        return <p className="goal-connect-message">No mock goal available.</p>
                }

                if (goalId !== ROOT_GOAL_ID && !selectedParentGoal) {
                        return (
                                <p className="goal-connect-message">
                                        Mock goal "{goalId}" was not found.
                                </p>
                        )
                }

                return (
                        <GoalViewer
                                parentGoal={selectedParentGoal}
                                children_goals={visibleGoals}
                                global_goals={mockGoals}
                        />
                )
        }

        return (
                <>
                        <button
                                type="button"
                                className="goal-view-button"
                                onClick={viewRootGoal}
                        >
                                View root goals
                        </button>
                        <p className="goal-connect-message">{message}</p>
                </>
        )
}

export default App
