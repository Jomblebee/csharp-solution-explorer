using MediatR;
using Microsoft.AspNetCore.Components;
using TaskFlow.Application.Projects.Commands.CreateProject;
using TaskFlow.Application.Projects.Queries.GetProjects;

namespace TaskFlow.Web.Components.Pages.Projects;

public class ProjectListBase : ComponentBase
{
    [Inject] private IMediator Mediator { get; set; } = null!;

    protected List<ProjectDto>? Projects { get; private set; }
    protected string NewProjectName { get; set; } = string.Empty;
    protected string? ErrorMessage { get; private set; }

    protected override async Task OnInitializedAsync()
    {
        Projects = await Mediator.Send(new GetProjectsQuery());
    }

    protected async Task CreateProject()
    {
        if (string.IsNullOrWhiteSpace(NewProjectName))
            return;

        try
        {
            ErrorMessage = null;
            await Mediator.Send(new CreateProjectCommand(NewProjectName, null));
            NewProjectName = string.Empty;
            Projects = await Mediator.Send(new GetProjectsQuery());
        }
        catch (Exception ex)
        {
            ErrorMessage = ex.Message;
        }
    }
}
