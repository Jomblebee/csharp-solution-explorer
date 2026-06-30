using MediatR;
using Microsoft.AspNetCore.Components;
using TaskFlow.Application.Projects.Queries.GetProjects;

namespace TaskFlow.Web.Components.Pages;

public class HomeBase : ComponentBase
{
    [Inject] private IMediator Mediator { get; set; } = null!;

    protected List<ProjectDto>? Projects { get; private set; }

    protected override async Task OnInitializedAsync()
    {
        Projects = await Mediator.Send(new GetProjectsQuery());
    }
}
