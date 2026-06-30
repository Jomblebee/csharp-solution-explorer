using MediatR;
using Microsoft.EntityFrameworkCore;
using TaskFlow.Application.Common.Interfaces;

namespace TaskFlow.Application.Projects.Queries.GetProjects;

public class GetProjectsQueryHandler(ITaskFlowDbContext db)
    : IRequestHandler<GetProjectsQuery, List<ProjectDto>>
{
    public async Task<List<ProjectDto>> Handle(GetProjectsQuery request, CancellationToken cancellationToken)
    {
        return await db.Projects
            .Select(p => new ProjectDto(p.Id, p.Name, p.Description, p.Tasks.Count))
            .ToListAsync(cancellationToken);
    }
}
