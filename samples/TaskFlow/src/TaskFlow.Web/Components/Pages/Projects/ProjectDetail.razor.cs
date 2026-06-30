using MediatR;
using Microsoft.AspNetCore.Components;
using TaskFlow.Application.Projects.Commands.DeleteProject;
using TaskFlow.Application.Projects.Queries.GetProjects;

namespace TaskFlow.Web.Components.Pages.Projects;

public class ProjectDetailBase : ComponentBase
{
    [Inject] private IMediator Mediator { get; set; } = null!;
    [Inject] private NavigationManager Nav { get; set; } = null!;

    [Parameter] public int ProjectId { get; set; }

    protected ProjectDto? Project { get; private set; }

    protected override async Task OnParametersSetAsync()
    {
        var projects = await Mediator.Send(new GetProjectsQuery());
        Project = projects.FirstOrDefault(p => p.Id == ProjectId);
    }

    protected async Task DeleteProject()
    {
        await Mediator.Send(new DeleteProjectCommand(ProjectId));
        Nav.NavigateTo("/projects");
    }
}
