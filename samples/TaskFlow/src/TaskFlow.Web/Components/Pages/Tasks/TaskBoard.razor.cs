using MediatR;
using Microsoft.AspNetCore.Components;
using TaskFlow.Application.Tasks.Commands.CreateTask;
using TaskFlow.Application.Tasks.Commands.UpdateTaskStatus;
using TaskFlow.Application.Tasks.Queries.GetTasksByProject;
using TaskFlow.Domain.Enums;

namespace TaskFlow.Web.Components.Pages.Tasks;

public class TaskBoardBase : ComponentBase
{
    [Inject] private IMediator Mediator { get; set; } = null!;

    [Parameter] public int ProjectId { get; set; }

    protected List<TaskDto>? Tasks { get; private set; }
    protected string NewTaskTitle { get; set; } = string.Empty;

    protected override async Task OnParametersSetAsync()
    {
        Tasks = await Mediator.Send(new GetTasksByProjectQuery(ProjectId));
    }

    protected async Task MoveForward(int taskId, AppTaskStatus current)
    {
        var next = current switch
        {
            AppTaskStatus.Todo => AppTaskStatus.InProgress,
            AppTaskStatus.InProgress => AppTaskStatus.Done,
            _ => current
        };
        await Mediator.Send(new UpdateTaskStatusCommand(taskId, next));
        Tasks = await Mediator.Send(new GetTasksByProjectQuery(ProjectId));
    }

    protected async Task MoveBack(int taskId, AppTaskStatus current)
    {
        var prev = current switch
        {
            AppTaskStatus.Done => AppTaskStatus.InProgress,
            AppTaskStatus.InProgress => AppTaskStatus.Todo,
            _ => current
        };
        await Mediator.Send(new UpdateTaskStatusCommand(taskId, prev));
        Tasks = await Mediator.Send(new GetTasksByProjectQuery(ProjectId));
    }

    protected async Task AddTask()
    {
        if (string.IsNullOrWhiteSpace(NewTaskTitle))
            return;

        await Mediator.Send(new CreateTaskCommand(ProjectId, NewTaskTitle, null, Priority.Medium));
        NewTaskTitle = string.Empty;
        Tasks = await Mediator.Send(new GetTasksByProjectQuery(ProjectId));
    }
}
