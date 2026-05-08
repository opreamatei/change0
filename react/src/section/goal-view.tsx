import { buildGoalPath } from '../config/utils';
import { findGoalByGlobalIndex, type Goal } from '../goal';

export interface GoalViewerProps {
	children_goals: Goal[];
	global_goals: Goal[];
	parentGoal: Goal | null;
}

function GoalData({goal} : {goal: Goal | null}){
	return goal ? (
		<div className="goal-meta">
		<h3>Current Goal</h3>
		<p>ID: {goal.id}</p>
		<p>Title: {goal.title}</p>
		</div>
	) : (
	<h3>Viewing as root</h3>
	)
};

function ChildrenGoalDisplay({children} : {children : Goal[]}){
	return (
			children.length > 0 && (
				<div className="goal-list">
				<h3>Goals</h3>

				{
					children.map(g => (
						<a
						key={g.id}
						href={buildGoalPath(g.id)}
						className="goal-link"
						>
						goal [{g.title}]
						</a>
					))
				}
				</div>
			)


	)
}

function GoToParentButton({global_goals, goal} : {global_goals : Goal[], goal : Goal | null}){
	const outer_parent_goal =
		goal?.parent
			? findGoalByGlobalIndex(global_goals, goal.parent)
			: null;

	return <a
	className="btn btn-secondary"
	href={buildGoalPath(
		outer_parent_goal
			? outer_parent_goal.id
			: "root"
	)}
	>
	Go back to parent
	</a>;
}

export default function GoalViewer(props: GoalViewerProps) {

	const { global_goals, children_goals, parentGoal } = props;


	return (
		<div className="goal-viewer">

			<GoalData goal={parentGoal} />
			
			<ChildrenGoalDisplay children = {children_goals}/>

			<GoToParentButton global_goals={global_goals} goal={parentGoal} />
		</div>
	);
}
